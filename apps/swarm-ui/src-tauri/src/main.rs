use std::sync::Arc;
use std::thread;
use std::time::Duration;

use swarm_ui::{
    bind::Binder,
    events::{BIND_RESOLVED, PTY_BOUND_EXIT},
    launch::LaunchConfig,
    model,
    pty::PtyManager,
    swarm::start_swarm_watcher,
    writes,
};
use tauri::{Emitter, Listener, Manager};
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

/// Heartbeat interval for UI-owned unadopted instance rows.
///
/// Bun-side `prune()` deletes rows with `heartbeat < now - 30s`, so we must
/// tick faster than that. 10s matches the in-process heartbeat the MCP
/// server runs once it adopts the row.
const UNADOPTED_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);

fn main() {
    tauri::Builder::default()
        .manage(PtyManager::new())
        .manage(Binder::new())
        .manage(LaunchConfig::load())
        .invoke_handler(tauri::generate_handler![
            swarm_ui::swarm::get_swarm_state,
            swarm_ui::pty::pty_write,
            swarm_ui::pty::pty_resize,
            swarm_ui::pty::pty_close,
            swarm_ui::pty::pty_get_buffer,
            swarm_ui::pty::get_pty_sessions,
            swarm_ui::launch::agent_spawn,
            swarm_ui::launch::spawn_shell,
            swarm_ui::launch::respawn_instance,
            swarm_ui::launch::get_role_presets,
            swarm_ui::bind::get_binding_state,
            swarm_ui::ui_commands::ui_clear_messages,
            swarm_ui::ui_commands::ui_unassign_task,
            swarm_ui::ui_commands::ui_remove_dependency,
            swarm_ui::ui_commands::ui_deregister_instance,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::HudWindow,
                    Some(NSVisualEffectState::Active),
                    None,
                );
            }

            // Sweep stale orphaned UI-owned rows from prior sessions. Fresh
            // `adopted=0` placeholders may still belong to another live UI
            // window or a slow-starting child, so `sweep_unadopted_orphans`
            // only removes rows whose heartbeat has already gone stale.
            match swarm_ui::writes::open_rw()
                .and_then(|conn| swarm_ui::writes::ensure_adopted_column(&conn).map(|()| conn))
                .and_then(|conn| swarm_ui::writes::sweep_unadopted_orphans(&conn))
            {
                Ok(0) => {}
                Ok(count) => eprintln!("[swarm-ui] swept {count} orphan unadopted row(s) on startup"),
                Err(err) => eprintln!("[swarm-ui] startup orphan sweep failed: {err}"),
            }

            let app_handle = app.handle().clone();
            let callback_handle = app_handle.clone();
            let callback = Arc::new(move |update: &model::SwarmUpdate| {
                let binder = callback_handle.state::<Binder>();
                let pty_manager = callback_handle.state::<PtyManager>();

                // Legacy label-token resolution path — kept so an externally
                // launched agent (manual `claude` with a hand-crafted label)
                // still binds. The primary UI-spawned flow binds immediately
                // in `launch::agent_spawn`.
                for event in binder.try_resolve(&update.instances) {
                    let _ = pty_manager.set_bound_instance(&event.pty_id, &event.instance_id);
                    let _ = callback_handle.emit(BIND_RESOLVED, &event);
                }
            });

            start_swarm_watcher(app_handle.clone(), Some(callback))?;

            // Clean up UI-owned instance rows when their PTY ends. The child
            // inside a registered PTY calls `swarm.deregister` itself on
            // shutdown (see `cleanup()` in `src/index.ts`), so
            // `delete_unadopted_instance` is a no-op there — it only deletes
            // rows the child never adopted.
            let cleanup_handle = app_handle.clone();
            app_handle.listen(PTY_BOUND_EXIT, move |event| {
                let payload: serde_json::Value = match serde_json::from_str(event.payload()) {
                    Ok(value) => value,
                    Err(err) => {
                        eprintln!("[pty:bound_exit] bad payload: {err}");
                        return;
                    }
                };
                let Some(instance_id) = payload.get("instance_id").and_then(|v| v.as_str()) else {
                    return;
                };

                cleanup_handle.state::<Binder>().unbind(instance_id);

                match writes::open_rw() {
                    Ok(conn) => {
                        if let Err(err) = writes::delete_unadopted_instance(&conn, instance_id) {
                            eprintln!(
                                "[pty:bound_exit] failed to delete unadopted instance {instance_id}: {err}"
                            );
                        }
                    }
                    Err(err) => {
                        eprintln!("[pty:bound_exit] failed to open swarm.db for cleanup: {err}");
                    }
                }
            });

            // Background heartbeat for UI-owned unadopted instance rows.
            // Runs until the app shuts down — unadopted rows have pid=0 and
            // will be pruned by the Bun side if we stop ticking.
            let heartbeat_handle = app_handle.clone();
            thread::spawn(move || unadopted_heartbeat_loop(heartbeat_handle));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn unadopted_heartbeat_loop(app_handle: tauri::AppHandle) {
    loop {
        thread::sleep(UNADOPTED_HEARTBEAT_INTERVAL);

        let pty_manager = app_handle.state::<PtyManager>();
        let Ok(sessions) = pty_manager.sessions_snapshot() else {
            continue;
        };

        let live_instance_ids: Vec<String> = sessions
            .into_iter()
            .filter_map(|session| {
                if session.exit_code.is_some() {
                    None
                } else {
                    session.bound_instance_id
                }
            })
            .collect();

        if live_instance_ids.is_empty() {
            continue;
        }

        let conn = match writes::open_rw() {
            Ok(conn) => conn,
            Err(err) => {
                eprintln!("[heartbeat] failed to open swarm.db: {err}");
                continue;
            }
        };

        for instance_id in &live_instance_ids {
            if let Err(err) = writes::heartbeat_unadopted_instance(&conn, instance_id) {
                eprintln!(
                    "[heartbeat] failed to refresh unadopted instance {instance_id}: {err}"
                );
            }
        }
    }
}

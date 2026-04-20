use swarm_ui::{
    bind::Binder, events::PTY_BOUND_EXIT, launch::LaunchConfig, pty::PtyManager,
    swarm::start_swarm_watcher,
};
use tauri::{Listener, Manager};
#[cfg(target_os = "macos")]
use window_vibrancy::{NSVisualEffectMaterial, NSVisualEffectState, apply_vibrancy};

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
            swarm_ui::pty::pty_request_lease,
            swarm_ui::pty::pty_release_lease,
            swarm_ui::pty::pty_get_buffer,
            swarm_ui::pty::get_pty_sessions,
            swarm_ui::launch::spawn_shell,
            swarm_ui::launch::respawn_instance,
            swarm_ui::launch::get_role_presets,
            swarm_ui::mobile_access::mobile_access_fetch_devices,
            swarm_ui::mobile_access::mobile_access_create_pairing_session,
            swarm_ui::mobile_access::mobile_access_cancel_pairing_session,
            swarm_ui::mobile_access::mobile_access_revoke_device,
            swarm_ui::bind::get_binding_state,
            swarm_ui::ui_commands::ui_clear_messages,
            swarm_ui::ui_commands::ui_unassign_task,
            swarm_ui::ui_commands::ui_remove_dependency,
            swarm_ui::ui_commands::ui_deregister_instance,
            swarm_ui::ui_commands::ui_deregister_offline_instances,
            swarm_ui::ui_commands::ui_set_layout,
            swarm_ui::ui_commands::ui_exit_app,
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

            if let Err(err) = swarm_ui::daemon::ensure_running() {
                eprintln!("[daemon] {err}");
            }

            let app_handle = app.handle().clone();
            start_swarm_watcher(app_handle.clone(), None)?;
            swarm_ui::ui_control::start_ui_command_worker(app_handle.clone());

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
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

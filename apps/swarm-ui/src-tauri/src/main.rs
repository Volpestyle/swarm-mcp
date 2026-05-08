use swarm_ui::{
    bind::Binder, events::PTY_BOUND_EXIT, launch::LaunchConfig, pty::PtyManager,
    swarm::start_swarm_watcher, writes,
};
use tauri::{Listener, Manager};
// window_vibrancy is intentionally not imported at startup. Vibrancy is now
// theme-controlled and applied at runtime by Liquid Glass themes via a
// ui_set_window_vibrancy command (see src/lib.rs / ui_appearance.rs). Keeping
// it out of `setup` lets Tron Encom OS at slider transparency=100% composite
// straight to the desktop instead of onto a dark HudWindow backdrop.

fn main() {
    tauri::Builder::default()
        .manage(PtyManager::new())
        .manage(Binder::new())
        .manage(LaunchConfig::load())
        .plugin(tauri_plugin_dialog::init())
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
            swarm_ui::launch::respawn_instance_in_project,
            swarm_ui::launch::get_role_presets,
            swarm_ui::provenance::ui_build_provenance,
            swarm_ui::mobile_access::mobile_access_fetch_devices,
            swarm_ui::mobile_access::mobile_access_create_pairing_session,
            swarm_ui::mobile_access::mobile_access_cancel_pairing_session,
            swarm_ui::mobile_access::mobile_access_revoke_device,
            swarm_ui::bind::get_binding_state,
            swarm_ui::ui_commands::ui_preflight_launch_command,
            swarm_ui::ui_commands::ui_write_codex_launch_script,
            swarm_ui::ui_commands::ui_resolve_swarm_mcp_server,
            swarm_ui::ui_commands::ui_set_instance_label,
            swarm_ui::ui_commands::ui_clear_messages,
            swarm_ui::ui_commands::ui_unassign_task,
            swarm_ui::ui_commands::ui_remove_dependency,
            swarm_ui::ui_commands::ui_deregister_instance,
            swarm_ui::ui_commands::ui_force_deregister_instance,
            swarm_ui::ui_commands::ui_deregister_offline_instances,
            swarm_ui::ui_commands::ui_sweep_unadopted_orphans,
            swarm_ui::ui_commands::ui_set_layout,
            swarm_ui::ui_commands::ui_export_layout,
            swarm_ui::ui_commands::ui_capture_screenshot,
            swarm_ui::ui_commands::ui_write_proof_pack,
            swarm_ui::ui_commands::ui_save_area_capture,
            swarm_ui::ui_commands::ui_save_session_closeout,
            swarm_ui::ui_commands::ui_launch_chrome,
            swarm_ui::ui_commands::ui_launch_native_app,
            swarm_ui::ui_commands::ui_list_browser_catalog,
            swarm_ui::ui_commands::ui_refresh_browser_catalog,
            swarm_ui::ui_commands::ui_refresh_browser_context,
            swarm_ui::ui_commands::ui_capture_browser_snapshot,
            swarm_ui::ui_commands::ui_open_browser_context,
            swarm_ui::ui_commands::ui_import_front_chrome_tab,
            swarm_ui::ui_commands::ui_list_chrome_tabs,
            swarm_ui::ui_commands::ui_import_chrome_tabs,
            swarm_ui::ui_commands::ui_close_browser_context,
            swarm_ui::ui_commands::ui_delete_browser_context,
            swarm_ui::ui_commands::ui_list_projects,
            swarm_ui::ui_commands::ui_default_project_root,
            swarm_ui::ui_commands::ui_ensure_project_folder,
            swarm_ui::ui_commands::ui_save_project,
            swarm_ui::ui_commands::ui_delete_project,
            swarm_ui::ui_commands::ui_attach_instance_to_project,
            swarm_ui::ui_commands::ui_detach_instance_from_project,
            swarm_ui::ui_commands::ui_list_project_assets,
            swarm_ui::ui_commands::ui_save_project_asset,
            swarm_ui::ui_commands::ui_create_project_note_asset,
            swarm_ui::ui_commands::ui_update_project_note_asset_content,
            swarm_ui::ui_commands::ui_open_project_asset_path,
            swarm_ui::ui_commands::ui_analyze_project_asset,
            swarm_ui::ui_commands::ui_get_asset_analyzer_settings,
            swarm_ui::ui_commands::ui_save_asset_analyzer_settings,
            swarm_ui::ui_commands::ui_read_asset_text_file,
            swarm_ui::ui_commands::ui_refresh_project_assets,
            swarm_ui::ui_commands::ui_delete_project_asset,
            swarm_ui::ui_commands::ui_attach_asset,
            swarm_ui::ui_commands::ui_detach_asset,
            swarm_ui::ui_commands::ui_exit_app,
            swarm_ui::ui_commands::ui_broadcast_message,
            swarm_ui::ui_commands::ui_send_message,
            swarm_ui::ui_commands::ui_send_sigint_scope,
            swarm_ui::ui_commands::ui_kill_instance,
            swarm_ui::system_load::ui_scan_system_load,
            swarm_ui::system_load::ui_kill_session_tree,
            swarm_ui::system_load::ui_kill_all_agent_sessions,
            swarm_ui::ui_appearance::ui_set_window_vibrancy,
        ])
        .setup(|app| {
            // Vibrancy is theme-controlled — Liquid Glass themes apply HudWindow
            // vibrancy at runtime; everything else (including Tron Encom OS)
            // gets a genuinely transparent window so the slider's see-through
            // end actually composites onto the desktop.

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

                if let Ok(conn) = writes::open_rw() {
                    if let Err(err) = writes::delete_unadopted_instance(&conn, instance_id) {
                        eprintln!("[swarm-ui] failed to delete unadopted instance {instance_id} on PTY exit: {err}");
                    }
                }
            });

            let heartbeat_handle = app_handle.clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(10));

                    let instance_ids = heartbeat_handle
                        .state::<Binder>()
                        .snapshot()
                        .resolved
                        .into_iter()
                        .map(|(instance_id, _)| instance_id)
                        .collect::<Vec<_>>();

                    if instance_ids.is_empty() {
                        continue;
                    }

                    let conn = match writes::open_rw() {
                        Ok(conn) => conn,
                        Err(err) => {
                            eprintln!("[swarm-ui] failed to open db for unadopted heartbeat: {err}");
                            continue;
                        }
                    };

                    for instance_id in instance_ids {
                        if let Err(err) = writes::heartbeat_unadopted_instance(&conn, &instance_id) {
                            eprintln!("[swarm-ui] failed to heartbeat unadopted instance {instance_id}: {err}");
                        }
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

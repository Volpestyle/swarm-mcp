use std::sync::Arc;

use swarm_ui::{
    bind::Binder, events::BIND_RESOLVED, launch::LaunchConfig, model, pty::PtyManager,
    swarm::start_swarm_watcher,
};
use tauri::{Emitter, Manager};
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

fn main() {
    tauri::Builder::default()
        .manage(PtyManager::new())
        .manage(Binder::new())
        .manage(LaunchConfig::load())
        .invoke_handler(tauri::generate_handler![
            swarm_ui::swarm::get_swarm_state,
            swarm_ui::pty::pty_create,
            swarm_ui::pty::pty_write,
            swarm_ui::pty::pty_resize,
            swarm_ui::pty::pty_close,
            swarm_ui::pty::pty_get_buffer,
            swarm_ui::pty::get_pty_sessions,
            swarm_ui::launch::agent_spawn,
            swarm_ui::launch::spawn_shell,
            swarm_ui::launch::get_role_presets,
            swarm_ui::bind::get_binding_state,
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

            let app_handle = app.handle().clone();
            let callback_handle = app_handle.clone();
            let callback = Arc::new(move |update: &model::SwarmUpdate| {
                let binder = callback_handle.state::<Binder>();
                let pty_manager = callback_handle.state::<PtyManager>();

                for event in binder.try_resolve(&update.instances) {
                    let _ = pty_manager.set_bound_instance(&event.pty_id, &event.instance_id);
                    let _ = callback_handle.emit(BIND_RESOLVED, &event);
                }
            });

            start_swarm_watcher(app_handle, Some(callback))?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

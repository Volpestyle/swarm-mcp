// =============================================================================
// ui_appearance.rs — runtime appearance commands (vibrancy, etc).
//
// Vibrancy is blur-controlled. A zero Backdrop Blur override invokes this with
// `None` so the window is genuinely transparent through to the desktop. Any
// non-zero blur invokes it with a material (usually HudWindow) so macOS can
// frost the desktop behind the Tauri window.
//
// Materials accepted (string -> NSVisualEffectMaterial):
//   "hud_window"             -> HudWindow
//   "sidebar"                -> Sidebar
//   "under_window_background"-> UnderWindowBackground
//   None / unknown           -> clear vibrancy
// =============================================================================

#[cfg(target_os = "macos")]
use tauri::Manager;

#[tauri::command]
pub fn ui_set_window_vibrancy(
    #[allow(unused_variables)] app: tauri::AppHandle,
    #[allow(unused_variables)] material: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{
            NSVisualEffectMaterial, NSVisualEffectState, apply_vibrancy, clear_vibrancy,
        };

        let Some(window) = app.get_webview_window("main") else {
            return Err("main window not found".to_string());
        };

        // Always clear first so the change is idempotent regardless of the
        // previous material.
        let _ = clear_vibrancy(&window);

        let Some(name) = material else {
            return Ok(());
        };

        let chosen = match name.as_str() {
            "hud_window" => NSVisualEffectMaterial::HudWindow,
            "sidebar" => NSVisualEffectMaterial::Sidebar,
            "under_window_background" => NSVisualEffectMaterial::UnderWindowBackground,
            other => return Err(format!("unknown vibrancy material: {other}")),
        };

        apply_vibrancy(&window, chosen, Some(NSVisualEffectState::Active), None)
            .map_err(|err| format!("apply_vibrancy failed: {err}"))
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Vibrancy is a macOS-only effect. On other platforms this is a no-op
        // success so the frontend can call it unconditionally without a
        // platform branch.
        Ok(())
    }
}

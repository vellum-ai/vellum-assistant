//! Eli HUD Tauri shell.
//!
//! The Rust side is intentionally minimal: it owns the window, system
//! tray, and global hotkey, and exposes a couple of trivial commands
//! the React front-end calls via `invoke`. Everything else
//! (gateway HTTP, SSE, mic capture, wake-word detection, transcript
//! state) lives in the WebView.

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

#[derive(Serialize, Clone)]
struct PlatformInfo {
    os: String,
    arch: String,
    version: String,
}

#[tauri::command]
fn platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[tauri::command]
fn toggle_main_window(app: AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let visible = window.is_visible().unwrap_or(false);
    if visible {
        window.hide().map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        window.show().map_err(|e| e.to_string())?;
        let _ = window.set_focus();
        Ok(true)
    }
}

#[tauri::command]
fn set_always_on_top(app: AppHandle, on: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_always_on_top(on).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Read the Picovoice Porcupine access key from the environment.
///
/// The HUD's wake-word detector runs inside the WebView using
/// `@picovoice/porcupine-web`, but Picovoice's terms forbid bundling
/// the access key into a redistributable build. We resolve it at
/// runtime from `PICOVOICE_ACCESS_KEY` so each user provides their
/// own (free-tier) key. Returns `None` when unset; the front-end
/// gracefully falls back to push-to-talk in that case.
#[tauri::command]
fn picovoice_access_key() -> Option<String> {
    std::env::var("PICOVOICE_ACCESS_KEY").ok().filter(|v| !v.is_empty())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let toggle = MenuItemBuilder::with_id("toggle", "Show / Hide HUD").build(app)?;
    let pin = MenuItemBuilder::with_id("pin", "Toggle always-on-top").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit Eli").build(app)?;
    MenuBuilder::new(app).items(&[&toggle, &pin, &quit]).build()
}

fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_tray_menu(app)?;
    let app_handle = app.clone();
    let _tray = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "toggle" => {
                let _ = toggle_main_window(app.clone());
            }
            "pin" => {
                if let Some(window) = app.get_webview_window("main") {
                    let pinned = window.is_always_on_top().unwrap_or(false);
                    let _ = window.set_always_on_top(!pinned);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(move |_tray, event| {
            if let TrayIconEvent::Click { .. } = event {
                let _ = toggle_main_window(app_handle.clone());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            platform_info,
            toggle_main_window,
            set_always_on_top,
            picovoice_access_key,
            quit_app
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Set up the global toggle hotkey. We register it from
            // JavaScript via the plugin so the React layer can change
            // the binding at runtime; the Rust side just emits an
            // event back into the front-end.
            if let Err(err) = install_tray(&handle) {
                eprintln!("eli-hud: failed to install tray icon: {err}");
            }

            // Emit a one-shot event so the front-end knows the shell
            // has finished its setup phase. Useful for showing the
            // arc-reactor "ready" pulse.
            let _ = handle.emit("eli://ready", ());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Eli HUD application");
}

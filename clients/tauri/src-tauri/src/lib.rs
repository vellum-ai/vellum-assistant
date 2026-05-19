//! Eli HUD Tauri shell.
//!
//! The Rust side is intentionally minimal: it owns the window, system
//! tray, and global hotkey, and exposes a couple of trivial commands
//! the React front-end calls via `invoke`. Everything else
//! (gateway HTTP, SSE, mic capture, wake-word detection, transcript
//! state) lives in the WebView.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::TcpStream,
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

#[derive(Serialize)]
struct HostCommandResult {
    endpoint: &'static str,
    payload: Value,
}

#[derive(Serialize, Clone)]
struct PlatformInfo {
    os: String,
    arch: String,
    version: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ActiveWindowContext {
    app_id: String,
    app_name: String,
    window_title: String,
    redacted: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuardianTokenFile {
    access_token: String,
    refresh_token: Option<String>,
    refresh_after: Option<i64>,
    access_token_expires_at: Option<i64>,
    refresh_token_expires_at: Option<i64>,
    guardian_principal_id: Option<String>,
    is_new: Option<bool>,
    device_id: Option<String>,
    leased_at: Option<String>,
}

static SPEECH_CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

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
        reveal_main_window(&app);
        Ok(true)
    }
}

fn reveal_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        // Recenters in case macOS restored an off-screen frame.
        let _ = window.center();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn set_always_on_top(app: AppHandle, on: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_always_on_top(on).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn speak_text(text: String, voice: Option<String>) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(());
    }
    stop_speech()?;

    let selected_voice = voice
        .unwrap_or_else(|| "Daniel".to_string())
        .trim()
        .to_string();
    let child = Command::new("/usr/bin/say")
        .arg("-v")
        .arg(if selected_voice.is_empty() {
            "Daniel"
        } else {
            selected_voice.as_str()
        })
        .arg(text)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("failed to start macOS speech: {err}"))?;

    let slot = SPEECH_CHILD.get_or_init(|| Mutex::new(None));
    let mut guard = slot
        .lock()
        .map_err(|_| "speech child lock poisoned".to_string())?;
    *guard = Some(child);
    Ok(())
}

#[tauri::command]
fn stop_speech() -> Result<(), String> {
    let slot = SPEECH_CHILD.get_or_init(|| Mutex::new(None));
    let mut guard = slot
        .lock()
        .map_err(|_| "speech child lock poisoned".to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[tauri::command]
fn guardian_access_token(assistant_id: String) -> Option<String> {
    let token_path = guardian_token_paths(&assistant_id)
        .into_iter()
        .find(|path| path.exists())?;
    let raw = std::fs::read_to_string(&token_path).ok()?;
    let mut parsed: GuardianTokenFile = serde_json::from_str(&raw).ok()?;

    if let Some((host, port)) = resolve_gateway_host_port(&assistant_id) {
        // First attempt token rotation using the existing refresh token.
        if let Some(refresh_token) = parsed.refresh_token.clone() {
            let mut headers = HashMap::new();
            headers.insert(
                "Authorization".to_string(),
                format!("Bearer {}", parsed.access_token),
            );
            if let Ok((status, body)) = http_post_loopback_json(
                &host,
                port,
                "/v1/guardian/refresh",
                &json!({ "refreshToken": refresh_token }).to_string(),
                &headers,
            ) {
                if status == 200 {
                    if let Ok(refreshed) = serde_json::from_str::<GuardianTokenFile>(&body) {
                        if !refreshed.access_token.is_empty() {
                            parsed = merge_guardian_token(parsed, refreshed);
                            persist_guardian_token(&token_path, &parsed);
                        }
                    }
                } else if status == 401 || status == 403 {
                    // Signature/policy drift fallback:
                    // reset one-time bootstrap lock and mint a fresh guardian token.
                    let _ = http_post_loopback_json(
                        &host,
                        port,
                        "/v1/guardian/reset-bootstrap",
                        "{}",
                        &HashMap::new(),
                    );
                    let device_id = parsed
                        .device_id
                        .clone()
                        .unwrap_or_else(|| format!("tauri-{}", random_bytes_hex(16)));
                    if let Ok((init_status, init_body)) = http_post_loopback_json(
                        &host,
                        port,
                        "/v1/guardian/init",
                        &json!({
                            "platform": "macos",
                            "deviceId": device_id,
                        })
                        .to_string(),
                        &HashMap::new(),
                    ) {
                        if init_status == 200 {
                            if let Ok(initialized) =
                                serde_json::from_str::<GuardianTokenFile>(&init_body)
                            {
                                if !initialized.access_token.is_empty() {
                                    parsed = merge_guardian_token(parsed, initialized);
                                    persist_guardian_token(&token_path, &parsed);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if parsed.access_token.is_empty() {
        None
    } else {
        Some(parsed.access_token)
    }
}

fn merge_guardian_token(
    existing: GuardianTokenFile,
    incoming: GuardianTokenFile,
) -> GuardianTokenFile {
    GuardianTokenFile {
        access_token: incoming.access_token,
        refresh_token: incoming.refresh_token.or(existing.refresh_token),
        refresh_after: incoming.refresh_after.or(existing.refresh_after),
        access_token_expires_at: incoming
            .access_token_expires_at
            .or(existing.access_token_expires_at),
        refresh_token_expires_at: incoming
            .refresh_token_expires_at
            .or(existing.refresh_token_expires_at),
        guardian_principal_id: incoming
            .guardian_principal_id
            .or(existing.guardian_principal_id),
        is_new: incoming.is_new.or(existing.is_new),
        device_id: incoming.device_id.or(existing.device_id),
        leased_at: incoming.leased_at.or(existing.leased_at),
    }
}

fn persist_guardian_token(path: &std::path::Path, token: &GuardianTokenFile) {
    if let Ok(serialized) = serde_json::to_string_pretty(token) {
        let _ = std::fs::write(path, format!("{serialized}\n"));
    }
}

fn random_bytes_hex(len: usize) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let mixed = now ^ (pid << 32);
    let raw = format!("{mixed:032x}");
    raw.chars().take(len * 2).collect()
}

fn resolve_gateway_host_port(assistant_id: &str) -> Option<(String, u16)> {
    let home = std::env::var("HOME").ok()?;
    let lockfile_path = std::path::Path::new(&home).join(".vellum.lock.json");
    let raw = std::fs::read_to_string(lockfile_path).ok()?;
    let parsed = serde_json::from_str::<Value>(&raw).ok()?;
    let assistants = parsed.get("assistants")?.as_array()?;
    for assistant in assistants {
        let Some(id) = assistant.get("assistantId").and_then(Value::as_str) else {
            continue;
        };
        if id != assistant_id {
            continue;
        }
        let port = assistant
            .get("resources")
            .and_then(|r| r.get("gatewayPort"))
            .and_then(Value::as_u64)
            .unwrap_or(7830) as u16;
        return Some(("127.0.0.1".to_string(), port));
    }
    Some(("127.0.0.1".to_string(), 7830))
}

fn http_post_loopback_json(
    host: &str,
    port: u16,
    path: &str,
    body: &str,
    headers: &HashMap<String, String>,
) -> Result<(u16, String), String> {
    if host != "localhost" && host != "127.0.0.1" && host != "::1" {
        return Err("Only loopback endpoints are allowed".to_string());
    }
    let mut stream = TcpStream::connect((host, port))
        .map_err(|err| format!("Could not connect to {host}:{port}: {err}"))?;
    let mut request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.as_bytes().len()
    );
    for (key, value) in headers {
        request.push_str(&format!("{key}: {value}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(body);
    stream
        .write_all(request.as_bytes())
        .map_err(|err| err.to_string())?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|err| err.to_string())?;
    let (head, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "Invalid HTTP response".to_string())?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "Missing HTTP status code".to_string())?;
    Ok((status, body.to_string()))
}

fn guardian_token_paths(assistant_id: &str) -> Vec<std::path::PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let xdg_config_home = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("{home}/.config"));
    let configured_env = std::env::var("VELLUM_ENVIRONMENT").ok();
    let envs = [
        configured_env.as_deref(),
        Some("production"),
        Some("local"),
        Some("dev"),
        Some("staging"),
        Some("test"),
    ];

    let mut paths = Vec::new();
    for env in envs.into_iter().flatten() {
        let dir_name = if env == "production" {
            "vellum".to_string()
        } else {
            format!("vellum-{env}")
        };
        let path = std::path::Path::new(&xdg_config_home)
            .join(dir_name)
            .join("assistants")
            .join(assistant_id)
            .join("guardian-token.json");
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths
}

#[tauri::command]
fn active_window_context() -> Result<Option<ActiveWindowContext>, String> {
    if std::env::consts::OS != "macos" {
        return Ok(None);
    }

    let script = r#"
tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  set appId to ""
  try
    set appId to bundle identifier of frontApp
  end try
  set windowTitle to ""
  try
    set windowTitle to name of front window of frontApp
  end try
  return appId & linefeed & appName & linefeed & windowTitle
end tell
"#;
    let output = Command::new("/usr/bin/osascript")
        .args(["-e", script])
        .output()
        .map_err(|err| format!("failed to launch osascript: {err}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut parts = stdout.trim_end_matches('\n').splitn(3, '\n');
    let app_id = parts.next().unwrap_or_default().trim().to_string();
    let app_name = parts.next().unwrap_or_default().trim().to_string();
    let window_title = parts.next().unwrap_or_default().trim().to_string();

    if is_blocked_app(&app_id, &app_name) {
        return Ok(None);
    }

    let (window_title, redacted) = redact_window_title(&window_title);
    Ok(Some(ActiveWindowContext {
        app_id,
        app_name,
        window_title,
        redacted,
    }))
}

fn is_blocked_app(app_id: &str, app_name: &str) -> bool {
    let app_id = app_id.to_ascii_lowercase();
    let app_name = app_name.to_ascii_lowercase();
    let blocked_ids = [
        "com.1password.1password",
        "com.agilebits.onepassword7",
        "com.apple.keychainaccess",
        "com.apple.systempreferences",
        "com.apple.systemsettings",
    ];
    blocked_ids.iter().any(|id| app_id == *id)
        || app_name.contains("1password")
        || app_name.contains("keychain access")
}

fn redact_window_title(title: &str) -> (String, bool) {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return (String::new(), false);
    }
    let lower = trimmed.to_ascii_lowercase();
    let sensitive_terms = [
        "private browsing",
        "incognito",
        "password",
        "passcode",
        "secret",
        "login",
        "log in",
        "sign in",
        "bank",
        "checkout",
        "payment",
    ];
    if sensitive_terms.iter().any(|term| lower.contains(term)) {
        return (String::new(), true);
    }
    if trimmed.len() > 512 {
        let mut out = trimmed.chars().take(512).collect::<String>();
        out.push_str("...");
        return (out, true);
    }
    (trimmed.to_string(), false)
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

struct BashResult {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
}

struct FileResult {
    content: String,
    is_error: bool,
}

struct BrowserResult {
    content: String,
    is_error: bool,
}

struct AppControlResult {
    state: &'static str,
    window_bounds: Value,
    execution_result: Value,
    execution_error: Value,
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(ToString::to_string)
}

fn number_field(value: &Value, key: &str) -> Option<f64> {
    value.get(key)?.as_f64()
}

fn object_string_map(value: Option<&Value>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Some(Value::Object(map)) = value {
        for (key, value) in map {
            if let Some(value) = value.as_str() {
                out.insert(key.clone(), value.to_string());
            }
        }
    }
    out
}

fn run_bash_command(
    command: &str,
    working_dir: Option<&str>,
    timeout_secs: f64,
    env: &HashMap<String, String>,
) -> BashResult {
    let fallback_home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let cwd = working_dir.unwrap_or(fallback_home.as_str());
    let mut command_builder = Command::new("/bin/bash");
    command_builder
        .args(["-c", "--", command])
        .current_dir(cwd)
        .envs(env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command_builder.spawn() {
        Ok(child) => child,
        Err(err) => {
            return BashResult {
                stdout: String::new(),
                stderr: format!("Failed to launch process: {err}"),
                exit_code: None,
                timed_out: false,
            }
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_handle = stdout.map(|mut stream| {
        thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stream.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        })
    });
    let stderr_handle = stderr.map(|mut stream| {
        thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stream.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        })
    });

    let deadline = Instant::now() + Duration::from_millis((timeout_secs * 1000.0) as u64);
    let (exit_code, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status.code(), false),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break (None, true);
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(err) => {
                return BashResult {
                    stdout: String::new(),
                    stderr: format!("Failed to wait for process: {err}"),
                    exit_code: None,
                    timed_out: false,
                }
            }
        }
    };

    BashResult {
        stdout: stdout_handle
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default(),
        stderr: stderr_handle
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default(),
        exit_code,
        timed_out,
    }
}

fn execute_file_request(request: &Value) -> FileResult {
    let operation = string_field(request, "operation").unwrap_or_default();
    let path = match string_field(request, "path") {
        Some(path) => path,
        None => {
            return FileResult {
                content: "path is required".to_string(),
                is_error: true,
            }
        }
    };

    match operation.as_str() {
        "read" => match std::fs::read_to_string(&path) {
            Ok(content) => {
                let offset = request.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
                let limit = request.get("limit").and_then(Value::as_u64).map(|v| v as usize);
                let lines: Vec<&str> = content.lines().collect();
                let end = limit
                    .map(|limit| offset.saturating_add(limit).min(lines.len()))
                    .unwrap_or(lines.len());
                let sliced = if offset < lines.len() {
                    lines[offset..end].join("\n")
                } else {
                    String::new()
                };
                FileResult {
                    content: sliced,
                    is_error: false,
                }
            }
            Err(err) => FileResult {
                content: err.to_string(),
                is_error: true,
            },
        },
        "write" => {
            let content = string_field(request, "content").unwrap_or_default();
            match std::fs::write(&path, content) {
                Ok(()) => FileResult {
                    content: format!("Wrote {path}"),
                    is_error: false,
                },
                Err(err) => FileResult {
                    content: err.to_string(),
                    is_error: true,
                },
            }
        }
        "edit" => {
            let old = string_field(request, "old_string")
                .or_else(|| string_field(request, "oldString"))
                .unwrap_or_default();
            let new = string_field(request, "new_string")
                .or_else(|| string_field(request, "newString"))
                .unwrap_or_default();
            let replace_all = request
                .get("replace_all")
                .or_else(|| request.get("replaceAll"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            match std::fs::read_to_string(&path) {
                Ok(content) => {
                    if old.is_empty() {
                        return FileResult {
                            content: "old_string is required".to_string(),
                            is_error: true,
                        };
                    }
                    let replaced = if replace_all {
                        content.replace(&old, &new)
                    } else {
                        content.replacen(&old, &new, 1)
                    };
                    if replaced == content {
                        return FileResult {
                            content: "old_string was not found".to_string(),
                            is_error: true,
                        };
                    }
                    match std::fs::write(&path, replaced) {
                        Ok(()) => FileResult {
                            content: format!("Edited {path}"),
                            is_error: false,
                        },
                        Err(err) => FileResult {
                            content: err.to_string(),
                            is_error: true,
                        },
                    }
                }
                Err(err) => FileResult {
                    content: err.to_string(),
                    is_error: true,
                },
            }
        }
        other => FileResult {
            content: format!("Unsupported host file operation: {other}"),
            is_error: true,
        },
    }
}

fn execute_browser_request(request: &Value) -> BrowserResult {
    let method = match string_field(request, "cdpMethod") {
        Some(method) => method,
        None => {
            return BrowserResult {
                content: "cdpMethod is required".to_string(),
                is_error: true,
            }
        }
    };
    let params = request
        .get("cdpParams")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let session_id = string_field(request, "cdpSessionId");
    let timeout = number_field(request, "timeout_seconds")
        .or_else(|| number_field(request, "timeoutSeconds"))
        .unwrap_or(30.0)
        .max(0.1);

    match discover_chrome_debugger_url()
        .and_then(|ws_url| send_cdp_command(&ws_url, &method, params, session_id, timeout))
    {
        Ok(value) => BrowserResult {
            content: value.to_string(),
            is_error: false,
        },
        Err(err) => BrowserResult {
            content: err,
            is_error: true,
        },
    }
}

fn discover_chrome_debugger_url() -> Result<String, String> {
    let body = http_get_loopback("localhost", 9222, "/json/version")?;
    let value: Value = serde_json::from_str(&body).map_err(|err| err.to_string())?;
    value
        .get("webSocketDebuggerUrl")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| "Chrome DevTools did not expose webSocketDebuggerUrl".to_string())
}

fn http_get_loopback(host: &str, port: u16, path: &str) -> Result<String, String> {
    if host != "localhost" && host != "127.0.0.1" && host != "::1" {
        return Err("Only loopback Chrome DevTools endpoints are allowed".to_string());
    }
    let mut stream = TcpStream::connect((host, port)).map_err(|err| {
        format!("Could not connect to Chrome DevTools at {host}:{port}: {err}")
    })?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| err.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|err| err.to_string())?;
    let (_, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "Invalid HTTP response from Chrome DevTools".to_string())?;
    Ok(body.to_string())
}

fn send_cdp_command(
    ws_url: &str,
    method: &str,
    params: Value,
    session_id: Option<String>,
    timeout_secs: f64,
) -> Result<Value, String> {
    let parsed = parse_ws_url(ws_url)?;
    let mut stream = TcpStream::connect((parsed.host.as_str(), parsed.port))
        .map_err(|err| format!("Could not connect to Chrome DevTools WebSocket: {err}"))?;
    stream
        .set_read_timeout(Some(Duration::from_millis((timeout_secs * 1000.0) as u64)))
        .map_err(|err| err.to_string())?;
    let handshake = format!(
        "GET {} HTTP/1.1\r\nHost: {}:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        parsed.path, parsed.host, parsed.port
    );
    stream
        .write_all(handshake.as_bytes())
        .map_err(|err| err.to_string())?;
    let mut header = Vec::new();
    let mut buf = [0_u8; 1];
    while !header.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut buf).map_err(|err| err.to_string())?;
        header.push(buf[0]);
        if header.len() > 16 * 1024 {
            return Err("Chrome DevTools WebSocket handshake was too large".to_string());
        }
    }
    let header_text = String::from_utf8_lossy(&header);
    if !header_text.contains("101 Switching Protocols") {
        return Err(format!("Chrome DevTools rejected WebSocket: {header_text}"));
    }

    let id = 1_i64;
    let mut command = json!({
        "id": id,
        "method": method,
        "params": params,
    });
    if let Some(session_id) = session_id {
        command["sessionId"] = Value::String(session_id);
    }
    send_ws_text(&mut stream, &command.to_string())?;

    let deadline = Instant::now() + Duration::from_millis((timeout_secs * 1000.0) as u64);
    while Instant::now() < deadline {
        let frame = read_ws_text(&mut stream)?;
        let value: Value = serde_json::from_str(&frame).map_err(|err| err.to_string())?;
        if value.get("id").and_then(Value::as_i64) == Some(id) {
            return Ok(value);
        }
    }
    Err("Timed out waiting for Chrome DevTools response".to_string())
}

struct ParsedWsUrl {
    host: String,
    port: u16,
    path: String,
}

fn parse_ws_url(url: &str) -> Result<ParsedWsUrl, String> {
    let rest = url
        .strip_prefix("ws://")
        .ok_or_else(|| "Only ws:// loopback DevTools URLs are supported".to_string())?;
    let (host_port, path) = rest
        .split_once('/')
        .map(|(host, path)| (host, format!("/{path}")))
        .unwrap_or((rest, "/".to_string()));
    let (host, port) = host_port
        .split_once(':')
        .ok_or_else(|| "DevTools WebSocket URL is missing a port".to_string())?;
    if host != "localhost" && host != "127.0.0.1" && host != "::1" {
        return Err("Only loopback Chrome DevTools endpoints are allowed".to_string());
    }
    Ok(ParsedWsUrl {
        host: host.to_string(),
        port: port.parse::<u16>().map_err(|err| err.to_string())?,
        path,
    })
}

fn send_ws_text(stream: &mut TcpStream, text: &str) -> Result<(), String> {
    let payload = text.as_bytes();
    let mask = ws_mask();
    let mut frame = Vec::new();
    frame.push(0x81);
    if payload.len() < 126 {
        frame.push(0x80 | payload.len() as u8);
    } else if payload.len() <= u16::MAX as usize {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        frame.push(0x80 | 127);
        frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    frame.extend_from_slice(&mask);
    for (idx, byte) in payload.iter().enumerate() {
        frame.push(byte ^ mask[idx % 4]);
    }
    stream.write_all(&frame).map_err(|err| err.to_string())
}

fn read_ws_text(stream: &mut TcpStream) -> Result<String, String> {
    let mut header = [0_u8; 2];
    stream.read_exact(&mut header).map_err(|err| err.to_string())?;
    let opcode = header[0] & 0x0f;
    let masked = header[1] & 0x80 != 0;
    let mut len = (header[1] & 0x7f) as u64;
    if len == 126 {
        let mut ext = [0_u8; 2];
        stream.read_exact(&mut ext).map_err(|err| err.to_string())?;
        len = u16::from_be_bytes(ext) as u64;
    } else if len == 127 {
        let mut ext = [0_u8; 8];
        stream.read_exact(&mut ext).map_err(|err| err.to_string())?;
        len = u64::from_be_bytes(ext);
    }
    let mut mask = [0_u8; 4];
    if masked {
        stream.read_exact(&mut mask).map_err(|err| err.to_string())?;
    }
    let mut payload = vec![0_u8; len as usize];
    stream
        .read_exact(&mut payload)
        .map_err(|err| err.to_string())?;
    if masked {
        for (idx, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[idx % 4];
        }
    }
    match opcode {
        1 => String::from_utf8(payload).map_err(|err| err.to_string()),
        8 => Err("Chrome DevTools closed the WebSocket".to_string()),
        _ => read_ws_text(stream),
    }
}

fn ws_mask() -> [u8; 4] {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    [
        (nanos & 0xff) as u8,
        ((nanos >> 8) & 0xff) as u8,
        ((nanos >> 16) & 0xff) as u8,
        ((nanos >> 24) & 0xff) as u8,
    ]
}

fn execute_app_control_request(request: &Value) -> AppControlResult {
    let input = match request.get("input") {
        Some(input) => input,
        None => return app_control_error("missing", "input is required"),
    };
    let tool = string_field(input, "tool").unwrap_or_default();
    match tool.as_str() {
        "start" => {
            let app = match string_field(input, "app") {
                Some(app) => app,
                None => return app_control_error("missing", "app is required"),
            };
            let mut command = Command::new("open");
            command.args(["-a", app.as_str()]);
            if let Some(Value::Array(args)) = input.get("args") {
                if !args.is_empty() {
                    command.arg("--args");
                    for arg in args.iter().filter_map(Value::as_str) {
                        command.arg(arg);
                    }
                }
            }
            match command.output() {
                Ok(output) if output.status.success() => AppControlResult {
                    state: "running",
                    window_bounds: Value::Null,
                    execution_result: json!(format!("Started {app}")),
                    execution_error: Value::Null,
                },
                Ok(output) => app_control_error(
                    "missing",
                    &String::from_utf8_lossy(&output.stderr),
                ),
                Err(err) => app_control_error("missing", &err.to_string()),
            }
        }
        "observe" => {
            let app = match string_field(input, "app") {
                Some(app) => app,
                None => return app_control_error("missing", "app is required"),
            };
            if let Some(ms) = input.get("settle_ms").and_then(Value::as_u64) {
                thread::sleep(Duration::from_millis(ms.min(5_000)));
            }
            observe_app(&app)
        }
        "type" => {
            let app = match string_field(input, "app") {
                Some(app) => app,
                None => return app_control_error("missing", "app is required"),
            };
            let text = string_field(input, "text").unwrap_or_default();
            run_osascript(&[
                "tell application \"System Events\"",
                &format!("tell process \"{}\" to set frontmost to true", escape_applescript(&app)),
                &format!("keystroke \"{}\"", escape_applescript(&text)),
                "end tell",
            ])
            .map(|_| AppControlResult {
                state: "running",
                window_bounds: Value::Null,
                execution_result: json!("typed text"),
                execution_error: Value::Null,
            })
            .unwrap_or_else(|err| app_control_error("running", &err))
        }
        "press" => {
            let app = string_field(input, "app").unwrap_or_default();
            let key = string_field(input, "key").unwrap_or_default();
            run_key_script(&app, &[key], string_array_field(input, "modifiers"))
        }
        "combo" => {
            let app = string_field(input, "app").unwrap_or_default();
            let keys = string_array_field(input, "keys");
            run_key_script(&app, &keys, Vec::new())
        }
        "sequence" => {
            let app = string_field(input, "app").unwrap_or_default();
            if let Some(Value::Array(steps)) = input.get("steps") {
                for step in steps {
                    let key = string_field(step, "key").unwrap_or_default();
                    let modifiers = string_array_field(step, "modifiers");
                    let result = run_key_script(&app, &[key], modifiers);
                    if !result.execution_error.is_null() {
                        return result;
                    }
                    let gap = step.get("gap_ms").and_then(Value::as_u64).unwrap_or(50);
                    thread::sleep(Duration::from_millis(gap.min(5_000)));
                }
                AppControlResult {
                    state: "running",
                    window_bounds: Value::Null,
                    execution_result: json!("sequence complete"),
                    execution_error: Value::Null,
                }
            } else {
                app_control_error("running", "steps must be an array")
            }
        }
        "click" => {
            let app = string_field(input, "app").unwrap_or_default();
            let x = number_field(input, "x").unwrap_or(0.0);
            let y = number_field(input, "y").unwrap_or(0.0);
            run_osascript(&[
                "tell application \"System Events\"",
                &format!("tell process \"{}\" to set frontmost to true", escape_applescript(&app)),
                &format!("click at {{{x}, {y}}}"),
                "end tell",
            ])
            .map(|_| AppControlResult {
                state: "running",
                window_bounds: Value::Null,
                execution_result: json!("click sent"),
                execution_error: Value::Null,
            })
            .unwrap_or_else(|err| app_control_error("running", &err))
        }
        "stop" => AppControlResult {
            state: "running",
            window_bounds: Value::Null,
            execution_result: json!("app control stopped"),
            execution_error: Value::Null,
        },
        other => app_control_error("running", &format!("Unsupported app-control tool: {other}")),
    }
}

fn observe_app(app: &str) -> AppControlResult {
    match run_osascript(&[
        "tell application \"System Events\"",
        &format!("if not (exists process \"{}\") then return \"missing\"", escape_applescript(app)),
        &format!("tell process \"{}\"", escape_applescript(app)),
        "set frontmost to true",
        "set p to position of window 1",
        "set s to size of window 1",
        "return (item 1 of p as text) & \",\" & (item 2 of p as text) & \",\" & (item 1 of s as text) & \",\" & (item 2 of s as text)",
        "end tell",
        "end tell",
    ]) {
        Ok(output) if output.trim() == "missing" => app_control_error("missing", "app is not running"),
        Ok(output) => {
            let parts: Vec<f64> = output
                .trim()
                .split(',')
                .filter_map(|part| part.trim().parse::<f64>().ok())
                .collect();
            let bounds = if parts.len() == 4 {
                json!({
                    "x": parts[0],
                    "y": parts[1],
                    "width": parts[2],
                    "height": parts[3],
                })
            } else {
                Value::Null
            };
            AppControlResult {
                state: "running",
                window_bounds: bounds,
                execution_result: json!("observed app"),
                execution_error: Value::Null,
            }
        }
        Err(err) => app_control_error("missing", &err),
    }
}

fn run_key_script(app: &str, keys: &[String], modifiers: Vec<String>) -> AppControlResult {
    let modifier_clause = if modifiers.is_empty() {
        String::new()
    } else {
        let modifiers = modifiers
            .iter()
            .map(|modifier| format!("{} down", modifier_key_name(modifier)))
            .collect::<Vec<_>>()
            .join(", ");
        format!(" using {{{modifiers}}}")
    };
    let result = run_osascript(&[
        "tell application \"System Events\"",
        &format!("tell process \"{}\" to set frontmost to true", escape_applescript(app)),
        &keys
            .iter()
            .map(|key| format!("keystroke \"{}\"{}", escape_applescript(key), modifier_clause))
            .collect::<Vec<_>>()
            .join("\n"),
        "end tell",
    ]);
    result
        .map(|_| AppControlResult {
            state: "running",
            window_bounds: Value::Null,
            execution_result: json!("key input sent"),
            execution_error: Value::Null,
        })
        .unwrap_or_else(|err| app_control_error("running", &err))
}

fn run_osascript(lines: &[&str]) -> Result<String, String> {
    let script = lines.join("\n");
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|err| err.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

fn string_array_field(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn modifier_key_name(modifier: &str) -> &'static str {
    match modifier.to_ascii_lowercase().as_str() {
        "cmd" | "command" | "meta" => "command",
        "ctrl" | "control" => "control",
        "alt" | "option" => "option",
        "shift" => "shift",
        _ => "command",
    }
}

fn escape_applescript(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn app_control_error(state: &'static str, error: &str) -> AppControlResult {
    AppControlResult {
        state,
        window_bounds: Value::Null,
        execution_result: Value::Null,
        execution_error: json!(error.trim()),
    }
}

#[tauri::command]
fn host_execute_bash(request: Value) -> HostCommandResult {
    let request_id = string_field(&request, "requestId").unwrap_or_default();
    let command = string_field(&request, "command").unwrap_or_default();
    let working_dir = string_field(&request, "working_dir")
        .or_else(|| string_field(&request, "workingDir"));
    let timeout_secs = number_field(&request, "timeout_seconds")
        .or_else(|| number_field(&request, "timeoutSeconds"))
        .unwrap_or(120.0)
        .max(0.1);
    let env = object_string_map(request.get("env"));

    let result = run_bash_command(&command, working_dir.as_deref(), timeout_secs, &env);
    HostCommandResult {
        endpoint: "host-bash-result",
        payload: json!({
            "requestId": request_id,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exitCode": result.exit_code,
            "timedOut": result.timed_out,
        }),
    }
}

#[tauri::command]
fn host_cancel_bash(_request_id: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn host_execute_file(request: Value) -> HostCommandResult {
    let request_id = string_field(&request, "requestId").unwrap_or_default();
    let result = execute_file_request(&request);
    HostCommandResult {
        endpoint: "host-file-result",
        payload: json!({
            "requestId": request_id,
            "content": result.content,
            "isError": result.is_error,
        }),
    }
}

#[tauri::command]
fn host_execute_browser(request: Value) -> HostCommandResult {
    let request_id = string_field(&request, "requestId").unwrap_or_default();
    let result = execute_browser_request(&request);
    HostCommandResult {
        endpoint: "host-browser-result",
        payload: json!({
            "requestId": request_id,
            "content": result.content,
            "isError": result.is_error,
        }),
    }
}

#[tauri::command]
fn host_execute_app_control(request: Value) -> HostCommandResult {
    let request_id = string_field(&request, "requestId").unwrap_or_default();
    let result = execute_app_control_request(&request);
    let mut payload = json!({
        "requestId": request_id,
        "state": result.state,
    });
    if !result.window_bounds.is_null() {
        payload["windowBounds"] = result.window_bounds;
    }
    if !result.execution_result.is_null() {
        payload["executionResult"] = result.execution_result;
    }
    if !result.execution_error.is_null() {
        payload["executionError"] = result.execution_error;
    }
    HostCommandResult {
        endpoint: "host-app-control-result",
        payload,
    }
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
            speak_text,
            stop_speech,
            guardian_access_token,
            active_window_context,
            quit_app,
            host_execute_bash,
            host_cancel_bash,
            host_execute_file,
            host_execute_browser,
            host_execute_app_control
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

            // Always surface the HUD on startup. In dev workflows macOS can
            // occasionally restore a hidden/off-screen frame from prior runs.
            reveal_main_window(&handle);

            // Emit a one-shot event so the front-end knows the shell
            // has finished its setup phase. Useful for showing the
            // arc-reactor "ready" pulse.
            let _ = handle.emit("eli://ready", ());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Eli HUD application");
}

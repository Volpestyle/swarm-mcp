// =============================================================================
// ui_commands.rs — Tauri commands for UI-initiated swarm writes
//
// Thin validation layer on top of `writes.rs`, mirroring the validation that
// `src/index.ts` applies before calling the pure helpers in `src/messages.ts`.
// Keeping validation here (not in `writes.rs`) matches the Bun side's split
// between MCP tool handlers and bare DB helpers.
// =============================================================================

use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use crate::{
    bind::Binder,
    daemon,
    model::{
        AppError, AssetAttachment, BrowserContext, BrowserSnapshot, BrowserSnapshotElement,
        BrowserTab, InstanceStatus, ProjectAsset, ProjectBoundary, ProjectMembership, ProjectSpace,
        SavedLayout,
    },
    pty::PtyManager,
    system_load::{KillTarget, kill_target_internal},
    writes,
};
use base64::{Engine as _, engine::general_purpose};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Runtime, State};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;

const LEARNING_EVOLUTION_ROOT: &str =
    "/Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution";

fn instance_status_from_heartbeat(heartbeat: i64) -> InstanceStatus {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or_default();
    InstanceStatus::from_heartbeat(now, heartbeat)
}

fn instance_status_label(status: InstanceStatus) -> &'static str {
    match status {
        InstanceStatus::Online => "online",
        InstanceStatus::Stale => "stale",
        InstanceStatus::Offline => "offline",
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCatalog {
    pub projects: Vec<ProjectSpace>,
    pub memberships: Vec<ProjectMembership>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAssetCatalog {
    pub assets: Vec<ProjectAsset>,
    pub attachments: Vec<AssetAttachment>,
    pub imported_count: usize,
    pub scanned_roots: Vec<String>,
    pub inventory: Vec<ProjectInventoryEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInventoryEntry {
    pub project_id: String,
    pub root: String,
    pub path: String,
    pub name: String,
    pub entry_type: String,
    pub category: String,
    pub extension: String,
    pub size_bytes: Option<u64>,
    pub modified_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaCaptureSaveResult {
    pub ok: bool,
    pub root: String,
    pub png_path: String,
    pub markdown_path: String,
    pub json_path: String,
    pub proof_level: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCloseoutSaveResult {
    pub ok: bool,
    pub root: String,
    pub markdown_path: String,
    pub json_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeLaunchResult {
    pub ok: bool,
    pub app: String,
    pub note: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAppLaunchResult {
    pub ok: bool,
    pub app_id: String,
    pub app: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontChromeTab {
    pub url: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeTabCandidate {
    pub id: String,
    pub window_index: i64,
    pub tab_index: i64,
    pub url: String,
    pub title: String,
    pub active: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCatalog {
    pub contexts: Vec<BrowserContext>,
    pub tabs: Vec<BrowserTab>,
    pub snapshots: Vec<BrowserSnapshot>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmMcpServerConfig {
    pub command: String,
    pub args: Vec<String>,
    pub source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchCommandPreflight {
    pub ok: bool,
    pub command: String,
    pub executable: String,
    pub resolved_path: Option<String>,
    pub shell: String,
    pub path_preview: String,
    pub diagnostics: Vec<String>,
    pub warnings: Vec<String>,
    pub blocker: Option<String>,
    pub trust_posture: String,
    pub native: bool,
}

#[derive(Debug, Deserialize)]
struct CdpListTab {
    #[serde(default)]
    id: String,
    #[serde(default, rename = "type")]
    tab_type: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default, rename = "webSocketDebuggerUrl")]
    web_socket_debugger_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CdpEvaluateResult {
    result: Option<CdpRemoteObject>,
    #[serde(rename = "exceptionDetails")]
    exception_details: Option<CdpExceptionDetails>,
}

#[derive(Debug, Deserialize)]
struct CdpRemoteObject {
    value: Option<Value>,
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CdpExceptionDetails {
    text: Option<String>,
    exception: Option<CdpRemoteObject>,
}

#[derive(Debug, Deserialize)]
struct CdpResponse<T> {
    id: Option<i64>,
    result: Option<T>,
    error: Option<CdpError>,
}

#[derive(Debug, Deserialize)]
struct CdpError {
    message: Option<String>,
    data: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BrowserSnapshotPage {
    #[serde(default)]
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    elements: Vec<BrowserSnapshotElement>,
}

const ASSET_KINDS: &[&str] = &[
    "image",
    "screenshot",
    "note",
    "folder",
    "protocol",
    "reference",
];
const ASSET_TARGET_TYPES: &[&str] = &["agent", "project", "protocol"];
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "svg"];
const OPENAI_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];
const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "json", "yaml", "yml", "rtf", "html", "htm", "css",
];
const MAX_DISCOVERED_ASSETS: usize = 200;
const MAX_DISCOVERY_DEPTH: usize = 2;
const MAX_PROJECT_INVENTORY_DEPTH: usize = 3;
const MAX_TEXT_ASSET_BYTES: u64 = 32_000;
const MAX_ANALYSIS_IMAGE_BYTES: u64 = 20_000_000;
const MAX_PROJECT_INVENTORY_ENTRIES: usize = 500;
const DEFAULT_OPENAI_VISION_MODEL: &str = "gpt-4.1-mini";
const PROJECT_WORKSPACE_DIR: &str = "workspace";
const ASSET_ANALYZER_CONFIG_FILE: &str = "asset-analyzer.json";
const ASSET_ANALYZER_KEYCHAIN_SERVICE: &str = "swarm-ui.asset-analyzer";
const ASSET_ANALYZER_OPENAI_ACCOUNT: &str = "openai-api-key";
const DEFAULT_CHROME_PATH: &str = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_BROWSER_HOST: &str = "127.0.0.1";
const DEFAULT_BROWSER_PORT: u16 = 9222;
const BROWSER_CONTEXT_ROOT: &str = "browser-contexts";
const CODEX_LAUNCH_SCRIPT_ROOT: &str = "codex-launch";

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetAnalyzerConfig {
    openai_model: Option<String>,
    custom_command: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetAnalyzerSettings {
    pub openai_configured: bool,
    pub openai_model: String,
    pub custom_command: String,
    pub config_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetAnalyzerSettingsInput {
    pub openai_api_key: Option<String>,
    pub openai_model: Option<String>,
    pub custom_command: Option<String>,
    pub clear_openai_api_key: bool,
}

fn trim_required(value: &str, field: &str) -> Result<String, AppError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(format!("{field} is required")));
    }
    Ok(trimmed.to_owned())
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(ToOwned::to_owned)
}

fn shell_words(command: &str, limit: usize) -> Result<Vec<String>, String> {
    let source = command.trim();
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaping = false;

    for ch in source.chars() {
        if escaping {
            current.push(ch);
            escaping = false;
            continue;
        }

        if ch == '\\' && quote != Some('\'') {
            escaping = true;
            continue;
        }

        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }

        if matches!(ch, '\'' | '"') {
            quote = Some(ch);
            continue;
        }

        if ch.is_whitespace() {
            if !current.is_empty() {
                words.push(current);
                current = String::new();
                if words.len() >= limit {
                    break;
                }
            }
            continue;
        }

        current.push(ch);
    }

    if escaping {
        current.push('\\');
    }

    if let Some(active_quote) = quote {
        let quote_name = if active_quote == '"' {
            "double"
        } else {
            "single"
        };
        return Err(format!("Command has an unterminated {quote_name} quote."));
    }

    if !current.is_empty() && words.len() < limit {
        words.push(current);
    }

    Ok(words)
}

fn is_env_assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn is_env_flag(word: &str) -> bool {
    matches!(word, "-" | "-i" | "-0" | "--ignore-environment")
}

fn extract_launch_executable(command: &str) -> Result<String, String> {
    let words = shell_words(command, 12)?;
    let mut index = 0;

    while let Some(word) = words.get(index) {
        if is_env_assignment(word) {
            index += 1;
            continue;
        }

        if matches!(word.as_str(), "exec" | "command" | "noglob") {
            index += 1;
            continue;
        }

        if word == "env" {
            index += 1;
            while let Some(candidate) = words.get(index) {
                if is_env_flag(candidate) || is_env_assignment(candidate) {
                    index += 1;
                    continue;
                }
                if matches!(candidate.as_str(), "-u" | "--unset") {
                    index += 2;
                    continue;
                }
                break;
            }
            continue;
        }

        return Ok(word.clone());
    }

    Err("Command does not include an executable.".into())
}

fn command_trust_posture(command: &str) -> &'static str {
    let normalized = command.to_ascii_lowercase();
    if normalized.contains("flux")
        || normalized.contains("dangerously")
        || normalized.contains("bypass")
        || normalized.contains("skip-permissions")
        || normalized.contains("skip permissions")
        || normalized.contains("full-access")
        || normalized.contains("full access")
        || normalized.contains("danger-full-access")
        || normalized.contains("no-sandbox")
    {
        "full-access"
    } else {
        "standard"
    }
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }

    #[cfg(not(unix))]
    {
        true
    }
}

fn login_shell_path() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|value| Path::new(value).is_file())
        .unwrap_or_else(|| "/bin/zsh".to_owned())
}

fn path_preview(raw_path: &str) -> String {
    let mut parts: Vec<&str> = raw_path
        .split(':')
        .filter(|part| !part.is_empty())
        .take(6)
        .collect();
    if parts.is_empty() {
        return String::new();
    }
    let truncated = raw_path.split(':').filter(|part| !part.is_empty()).count() > parts.len();
    let mut preview = parts.join(":");
    if truncated {
        preview.push_str(":...");
    }
    parts.clear();
    preview
}

fn launch_preflight_warnings(command: &str, executable: &str) -> Vec<String> {
    if command_trust_posture(command) == "full-access" {
        vec![format!(
            "Full-access command posture: {executable} can bypass normal permission or sandbox checks."
        )]
    } else {
        Vec::new()
    }
}

fn preflight_slash_command(
    command: &str,
    executable: &str,
    cwd: Option<String>,
) -> LaunchCommandPreflight {
    let executable_path = Path::new(executable);
    let resolved = if executable_path.is_absolute() {
        executable_path.to_path_buf()
    } else {
        cwd.as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
            .join(executable_path)
    };
    let blocker = if executable_file(&resolved) {
        None
    } else if resolved.exists() {
        Some(format!(
            "Launch command is not executable: {}",
            resolved.display()
        ))
    } else {
        Some(format!(
            "Launch command does not exist: {}",
            resolved.display()
        ))
    };

    LaunchCommandPreflight {
        ok: blocker.is_none(),
        command: command.to_owned(),
        executable: executable.to_owned(),
        resolved_path: Some(resolved.to_string_lossy().into_owned()),
        shell: "direct path".to_owned(),
        path_preview: String::new(),
        diagnostics: Vec::new(),
        warnings: launch_preflight_warnings(command, executable),
        blocker,
        trust_posture: command_trust_posture(command).to_owned(),
        native: true,
    }
}

fn parse_shell_resolution(stdout: &str) -> (String, String, bool, Option<String>) {
    let mut shell = String::new();
    let mut path = String::new();
    let mut ok = false;
    let mut resolved = None;
    let mut accept_resolution = false;

    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Some(value) = line.strip_prefix("__SWARM_PREFLIGHT_SHELL__=") {
            shell = value.to_owned();
            continue;
        }
        if let Some(value) = line.strip_prefix("__SWARM_PREFLIGHT_PATH__=") {
            path = value.to_owned();
            continue;
        }
        if let Some(value) = line.strip_prefix("__SWARM_PREFLIGHT_OK__=") {
            ok = value == "1";
            accept_resolution = ok;
            continue;
        }
        if accept_resolution && resolved.is_none() {
            resolved = Some(line.to_owned());
        }
    }

    (shell, path, ok, resolved)
}

#[tauri::command]
pub fn ui_preflight_launch_command(
    command: String,
    cwd: Option<String>,
) -> Result<LaunchCommandPreflight, AppError> {
    let launch_command = command.trim().to_owned();
    if launch_command.is_empty() {
        return Ok(LaunchCommandPreflight {
            ok: false,
            command: launch_command,
            executable: String::new(),
            resolved_path: None,
            shell: login_shell_path(),
            path_preview: String::new(),
            diagnostics: Vec::new(),
            warnings: Vec::new(),
            blocker: Some("Launch command is empty.".into()),
            trust_posture: "standard".into(),
            native: true,
        });
    }

    if launch_command.contains('\0') {
        return Ok(LaunchCommandPreflight {
            ok: false,
            command: launch_command,
            executable: String::new(),
            resolved_path: None,
            shell: login_shell_path(),
            path_preview: String::new(),
            diagnostics: Vec::new(),
            warnings: Vec::new(),
            blocker: Some("Launch command contains an invalid null byte.".into()),
            trust_posture: "standard".into(),
            native: true,
        });
    }

    let executable = match extract_launch_executable(&launch_command) {
        Ok(value) => value,
        Err(err) => {
            return Ok(LaunchCommandPreflight {
                ok: false,
                command: launch_command.clone(),
                executable: String::new(),
                resolved_path: None,
                shell: login_shell_path(),
                path_preview: String::new(),
                diagnostics: Vec::new(),
                warnings: launch_preflight_warnings(&launch_command, ""),
                blocker: Some(err),
                trust_posture: command_trust_posture(&launch_command).to_owned(),
                native: true,
            });
        }
    };

    if executable.contains('/') {
        return Ok(preflight_slash_command(&launch_command, &executable, cwd));
    }

    let shell = login_shell_path();
    let script = r#"
cmd="$1"
print -r -- "__SWARM_PREFLIGHT_SHELL__=$SHELL"
print -r -- "__SWARM_PREFLIGHT_PATH__=$PATH"
if command -v -- "$cmd" >/dev/null 2>&1; then
  print -r -- "__SWARM_PREFLIGHT_OK__=1"
  command -v -- "$cmd"
else
  print -r -- "__SWARM_PREFLIGHT_OK__=0"
fi
"#;
    let output = Command::new(&shell)
        .arg("-lic")
        .arg(script)
        .arg("swarm-ui-preflight")
        .arg(&executable)
        .env("SWARM_UI_PREFLIGHT", "1")
        .output()
        .map_err(|err| {
            AppError::Operation(format!("failed to run login-shell launch preflight: {err}"))
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let (reported_shell, path, shell_ok, resolved) = parse_shell_resolution(&stdout);
    let mut diagnostics = Vec::new();
    if !stderr.is_empty() {
        diagnostics.push(stderr);
    }
    if !output.status.success() {
        diagnostics.push(format!("login shell exited with {}", output.status));
    }

    let blocker = if shell_ok {
        None
    } else {
        Some(format!(
            "Command `{executable}` was not found by login shell `{}`.",
            if reported_shell.is_empty() {
                shell.as_str()
            } else {
                reported_shell.as_str()
            }
        ))
    };

    Ok(LaunchCommandPreflight {
        ok: blocker.is_none(),
        command: launch_command.clone(),
        executable: executable.clone(),
        resolved_path: resolved,
        shell: if reported_shell.is_empty() {
            shell
        } else {
            reported_shell
        },
        path_preview: path_preview(&path),
        diagnostics,
        warnings: launch_preflight_warnings(&launch_command, &executable),
        blocker,
        trust_posture: command_trust_posture(&launch_command).to_owned(),
        native: true,
    })
}

fn codex_launch_script_root() -> Result<PathBuf, AppError> {
    dirs::home_dir()
        .map(|home| {
            home.join(".swarm-mcp")
                .join("swarm-ui")
                .join(CODEX_LAUNCH_SCRIPT_ROOT)
        })
        .ok_or_else(|| AppError::Operation("failed to resolve home directory".into()))
}

fn scope_path(scope: Option<String>) -> Option<PathBuf> {
    let value = normalize_optional(scope)?;
    let path = value
        .split_once('#')
        .map_or(value.as_str(), |(path, _)| path);
    let path = PathBuf::from(path);
    path.is_absolute().then_some(path)
}

fn dist_index_candidate(root: PathBuf, source: &str) -> Option<SwarmMcpServerConfig> {
    let index = root.join("dist").join("index.js");
    index.is_file().then(|| SwarmMcpServerConfig {
        command: "node".to_owned(),
        args: vec![index.to_string_lossy().into_owned()],
        source: source.to_owned(),
    })
}

fn workspace_root_from_manifest_dir(manifest_dir: &Path) -> Option<PathBuf> {
    manifest_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .filter(|root| root.join("apps").join("swarm-ui").join("src-tauri") == manifest_dir)
}

fn manifest_dist_index_candidate() -> Option<SwarmMcpServerConfig> {
    workspace_root_from_manifest_dir(Path::new(env!("CARGO_MANIFEST_DIR")))
        .and_then(|root| dist_index_candidate(root, "workspace-dist"))
}

fn installed_swarm_mcp_binary() -> Option<SwarmMcpServerConfig> {
    let path = Command::new("sh")
        .arg("-lc")
        .arg("command -v swarm-mcp")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|value| !value.is_empty())?;
    Some(SwarmMcpServerConfig {
        command: path,
        args: Vec::new(),
        source: "path".to_owned(),
    })
}

fn sanitize_script_name(value: &str) -> String {
    let mut sanitized = String::new();
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
            sanitized.push(ch);
        } else {
            sanitized.push('_');
        }
    }
    if sanitized.is_empty() {
        Uuid::new_v4().to_string()
    } else {
        sanitized.chars().take(96).collect()
    }
}

fn shell_single_quote(value: &str) -> String {
    let mut quoted = String::from("'");
    for ch in value.chars() {
        if ch == '\'' {
            quoted.push_str("'\\''");
        } else {
            quoted.push(ch);
        }
    }
    quoted.push('\'');
    quoted
}

fn normalize_browser_url(value: Option<String>) -> String {
    let Some(trimmed) = normalize_optional(value) else {
        return "about:blank".into();
    };
    if trimmed == "about:blank" || trimmed.contains("://") {
        return trimmed;
    }
    if trimmed.starts_with("localhost:")
        || trimmed.starts_with("127.0.0.1:")
        || trimmed.starts_with("[::1]:")
    {
        return format!("http://{trimmed}");
    }
    format!("https://{trimmed}")
}

fn parse_front_chrome_tab_output(raw: &str) -> Result<FrontChromeTab, AppError> {
    let mut lines = raw.lines();
    let url = lines.next().unwrap_or_default().trim();
    let title = lines.collect::<Vec<_>>().join("\n").trim().to_owned();
    if url.is_empty() {
        return Err(AppError::Operation(
            "Google Chrome did not report an active tab URL".into(),
        ));
    }
    Ok(FrontChromeTab {
        url: url.to_owned(),
        title,
    })
}

fn parse_chrome_tabs_output(raw: &str) -> Vec<ChromeTabCandidate> {
    raw.lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let window_index = parts.next()?.trim().parse::<i64>().ok()?;
            let tab_index = parts.next()?.trim().parse::<i64>().ok()?;
            let active = parts.next()?.trim() == "1";
            let url = parts.next()?.trim().to_owned();
            let title = parts.collect::<Vec<_>>().join("\t").trim().to_owned();
            if url.is_empty() {
                return None;
            }
            Some(ChromeTabCandidate {
                id: format!("w{window_index}:t{tab_index}"),
                window_index,
                tab_index,
                url,
                title,
                active,
            })
        })
        .collect()
}

fn front_chrome_tab() -> Result<FrontChromeTab, AppError> {
    let running = Command::new("osascript")
        .arg("-e")
        .arg(r#"application "Google Chrome" is running"#)
        .output()
        .map_err(|err| AppError::Operation(format!("failed to query Google Chrome: {err}")))?;
    if !running.status.success() || String::from_utf8_lossy(&running.stdout).trim() != "true" {
        return Err(AppError::Operation(
            "Google Chrome is not running. Open the tab you want to import first.".into(),
        ));
    }

    let output = Command::new("osascript")
        .arg("-e")
        .arg(
            r#"tell application "Google Chrome"
  if not (exists front window) then error "Google Chrome has no front window"
  set activeTab to active tab of front window
  return (URL of activeTab) & linefeed & (title of activeTab)
end tell"#,
        )
        .output()
        .map_err(|err| AppError::Operation(format!("failed to read Google Chrome tab: {err}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(AppError::Operation(if stderr.is_empty() {
            "failed to read the active Google Chrome tab".into()
        } else {
            format!("failed to read the active Google Chrome tab: {stderr}")
        }));
    }

    parse_front_chrome_tab_output(&String::from_utf8_lossy(&output.stdout))
}

fn chrome_tabs() -> Result<Vec<ChromeTabCandidate>, AppError> {
    let running = Command::new("osascript")
        .arg("-e")
        .arg(r#"application "Google Chrome" is running"#)
        .output()
        .map_err(|err| AppError::Operation(format!("failed to query Google Chrome: {err}")))?;
    if !running.status.success() || String::from_utf8_lossy(&running.stdout).trim() != "true" {
        return Err(AppError::Operation(
            "Google Chrome is not running. Open the tabs you want to import first.".into(),
        ));
    }

    let output = Command::new("osascript")
        .arg("-e")
        .arg(
            r#"tell application "Google Chrome"
  if not (exists front window) then error "Google Chrome has no open windows"
  set outText to ""
  set lineSep to ASCII character 10
  set tabSep to ASCII character 9
  repeat with wIndex from 1 to count windows
    set winRef to window wIndex
    set activeIndex to active tab index of winRef
    repeat with tIndex from 1 to count tabs of winRef
      set tabRef to tab tIndex of winRef
      set activeFlag to "0"
      if wIndex is 1 and tIndex is activeIndex then set activeFlag to "1"
      set outText to outText & wIndex & tabSep & tIndex & tabSep & activeFlag & tabSep & (URL of tabRef) & tabSep & (title of tabRef) & lineSep
    end repeat
  end repeat
  return outText
end tell"#,
        )
        .output()
        .map_err(|err| AppError::Operation(format!("failed to list Google Chrome tabs: {err}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(AppError::Operation(if stderr.is_empty() {
            "failed to list Google Chrome tabs".into()
        } else {
            format!("failed to list Google Chrome tabs: {stderr}")
        }));
    }

    let tabs = parse_chrome_tabs_output(&String::from_utf8_lossy(&output.stdout));
    if tabs.is_empty() {
        return Err(AppError::Operation(
            "Google Chrome did not report any importable tabs".into(),
        ));
    }
    Ok(tabs)
}

fn browser_catalog(scope: &str) -> Result<BrowserCatalog, AppError> {
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    Ok(BrowserCatalog {
        contexts: writes::list_browser_contexts(&conn, scope).map_err(AppError::Operation)?,
        tabs: writes::list_browser_tabs(&conn, scope).map_err(AppError::Operation)?,
        snapshots: writes::list_browser_snapshots(&conn, scope, 40).map_err(AppError::Operation)?,
    })
}

fn browser_context_root() -> Result<PathBuf, AppError> {
    dirs::home_dir()
        .map(|home| home.join(".swarm-mcp").join(BROWSER_CONTEXT_ROOT))
        .ok_or_else(|| AppError::Operation("failed to resolve home directory".into()))
}

fn remove_browser_profile_dir(profile_dir: &str) -> Result<(), AppError> {
    let root = browser_context_root()?;
    let path = Path::new(profile_dir);
    if !path.starts_with(&root) {
        return Err(AppError::Validation(format!(
            "refusing to delete browser profile outside {}",
            root.display()
        )));
    }
    if path.exists() {
        fs::remove_dir_all(path).map_err(|err| {
            AppError::Operation(format!(
                "failed to remove browser profile {}: {err}",
                path.display()
            ))
        })?;
    }
    Ok(())
}

fn native_app_name(app_id: &str) -> Result<&'static str, AppError> {
    match app_id.trim().to_ascii_lowercase().as_str() {
        "chrome" => Ok("Google Chrome"),
        "notes" | "apple-notes" | "apple_notes" => Ok("Notes"),
        "obsidian" => Ok("Obsidian"),
        other => Err(AppError::Validation(format!(
            "unsupported native app: {other}"
        ))),
    }
}

fn browser_port_available(port: u16) -> bool {
    TcpListener::bind((DEFAULT_BROWSER_HOST, port)).is_ok()
}

fn allocate_browser_port() -> Result<u16, AppError> {
    if browser_port_available(DEFAULT_BROWSER_PORT) {
        return Ok(DEFAULT_BROWSER_PORT);
    }

    let listener = TcpListener::bind((DEFAULT_BROWSER_HOST, 0))
        .map_err(|err| AppError::Operation(format!("failed to allocate browser port: {err}")))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|err| AppError::Operation(format!("failed to inspect browser port: {err}")))
}

fn cdp_ready(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(350)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(350)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(350)));
    if stream
        .write_all(b"GET /json/version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0_u8; 256];
    match stream.read(&mut buf) {
        Ok(count) => String::from_utf8_lossy(&buf[..count]).contains(" 200 "),
        Err(_) => false,
    }
}

fn wait_for_cdp(port: u16) -> Result<(), AppError> {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if cdp_ready(port) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(AppError::Operation(
        "managed browser did not expose Chrome DevTools in time".into(),
    ))
}

fn signal_pid(pid: i64, signal: &str) -> Result<bool, AppError> {
    if pid <= 0 {
        return Ok(false);
    }
    let status = Command::new("kill")
        .arg(signal)
        .arg(pid.to_string())
        .status()
        .map_err(|err| {
            AppError::Operation(format!("failed to signal browser process {pid}: {err}"))
        })?;
    Ok(status.success())
}

fn browser_pid_alive(pid: i64) -> bool {
    signal_pid(pid, "-0").unwrap_or(false)
}

fn terminate_browser_pid(pid: i64) -> Result<(), AppError> {
    if pid <= 0 {
        return Ok(());
    }
    let _ = signal_pid(pid, "-TERM")?;
    std::thread::sleep(Duration::from_millis(250));
    if browser_pid_alive(pid) {
        let _ = signal_pid(pid, "-KILL")?;
    }
    Ok(())
}

fn cdp_get_body(host: &str, port: i64, path: &str) -> Result<String, AppError> {
    let port = u16::try_from(port)
        .map_err(|_| AppError::Operation(format!("invalid browser CDP port {port}")))?;
    let addr = (host, port)
        .to_socket_addrs()
        .map_err(|err| AppError::Operation(format!("failed to resolve browser endpoint: {err}")))?
        .next()
        .ok_or_else(|| AppError::Operation("browser endpoint did not resolve".into()))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(700))
        .map_err(|err| AppError::Operation(format!("failed to connect to browser CDP: {err}")))?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(900)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(700)));
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|err| AppError::Operation(format!("failed to request browser CDP: {err}")))?;

    let response = read_http_response_to_string(&mut stream)?;
    let status = response.lines().next().unwrap_or_default();
    if !status.contains(" 200 ") {
        return Err(AppError::Operation(format!(
            "browser CDP returned unexpected status: {status}"
        )));
    }
    response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_owned())
        .ok_or_else(|| AppError::Operation("browser CDP response was missing a body".into()))
}

fn http_response_complete(response: &[u8]) -> bool {
    let Some(header_end) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    let headers = String::from_utf8_lossy(&response[..header_end]).to_ascii_lowercase();
    if headers.contains("transfer-encoding: chunked") {
        return response[header_end + 4..]
            .windows(5)
            .any(|window| window == b"0\r\n\r\n");
    }
    let content_length = headers.lines().find_map(|line| {
        line.strip_prefix("content-length:")
            .and_then(|value| value.trim().parse::<usize>().ok())
    });
    if let Some(length) = content_length {
        return response.len().saturating_sub(header_end + 4) >= length;
    }
    false
}

fn read_http_response_to_string(stream: &mut TcpStream) -> Result<String, AppError> {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut response = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                response.extend_from_slice(&buffer[..count]);
                if http_response_complete(&response) {
                    break;
                }
            }
            Err(err)
                if matches!(
                    err.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if http_response_complete(&response) {
                    break;
                }
                if Instant::now() >= deadline {
                    if response.is_empty() {
                        return Err(AppError::Operation(format!(
                            "browser CDP response timed out: {err}"
                        )));
                    }
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(err) => {
                return Err(AppError::Operation(format!(
                    "failed to read browser CDP response: {err}"
                )));
            }
        }
    }
    String::from_utf8(response)
        .map_err(|err| AppError::Operation(format!("browser CDP response was not UTF-8: {err}")))
}

fn parse_cdp_tabs(
    scope: &str,
    context_id: &str,
    body: &str,
    updated_at: i64,
) -> Result<Vec<BrowserTab>, AppError> {
    let raw_tabs: Vec<CdpListTab> = serde_json::from_str(body)
        .map_err(|err| AppError::Operation(format!("failed to parse browser tabs: {err}")))?;
    let active_id = raw_tabs
        .iter()
        .find(|tab| tab.tab_type == "page" && !tab.id.is_empty())
        .or_else(|| raw_tabs.iter().find(|tab| !tab.id.is_empty()))
        .map(|tab| tab.id.clone());

    Ok(raw_tabs
        .into_iter()
        .filter(|tab| !tab.id.is_empty())
        .map(|tab| {
            let active = active_id.as_deref() == Some(tab.id.as_str());
            BrowserTab {
                scope: scope.to_owned(),
                context_id: context_id.to_owned(),
                tab_id: tab.id,
                tab_type: tab.tab_type,
                url: tab.url,
                title: tab.title,
                active,
                updated_at,
            }
        })
        .collect())
}

fn parse_cdp_tab_list(body: &str) -> Result<Vec<CdpListTab>, AppError> {
    serde_json::from_str(body)
        .map_err(|err| AppError::Operation(format!("failed to parse browser tabs: {err}")))
}

fn build_browser_snapshot_expression(max_text_length: usize, max_elements: usize) -> String {
    format!(
        r#"(() => {{
  const maxTextLength = {max_text_length};
  const maxElements = {max_elements};
  const text = (document.body?.innerText || document.documentElement?.innerText || '').trim().slice(0, maxTextLength);
  const selectorFor = (el) => {{
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 4) {{
      let part = node.localName;
      if (node.classList?.length) part += '.' + Array.from(node.classList).slice(0, 2).map((x) => CSS.escape(x)).join('.');
      const parent = node.parentElement;
      if (parent) {{
        const siblings = Array.from(parent.children).filter((child) => child.localName === node.localName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }}
      parts.unshift(part);
      node = parent;
    }}
    return parts.join(' > ');
  }};
  const candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],h1,h2,h3,label,[tabindex]'));
  const elements = candidates.slice(0, maxElements).map((el) => ({{
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    text: ((el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '') + '').trim().slice(0, 240),
    selector: selectorFor(el),
  }}));
  return {{ url: location.href, title: document.title, text, elements }};
}})()"#
    )
}

fn cdp_exception_message(details: CdpExceptionDetails) -> String {
    details
        .exception
        .and_then(|exception| exception.description)
        .or(details.text)
        .unwrap_or_else(|| "Runtime.evaluate failed".into())
}

async fn cdp_evaluate_value(web_socket_url: &str, expression: String) -> Result<Value, AppError> {
    let (mut socket, _) = connect_async(web_socket_url).await.map_err(|err| {
        AppError::Operation(format!("failed to connect to browser tab CDP: {err}"))
    })?;
    let request = json!({
        "id": 1,
        "method": "Runtime.evaluate",
        "params": {
            "expression": expression,
            "returnByValue": true,
            "awaitPromise": true,
        }
    });
    socket
        .send(Message::Text(request.to_string().into()))
        .await
        .map_err(|err| {
            AppError::Operation(format!("failed to send browser snapshot command: {err}"))
        })?;

    while let Some(frame) = socket.next().await {
        let frame = frame.map_err(|err| {
            AppError::Operation(format!("browser snapshot websocket failed: {err}"))
        })?;
        let raw = match frame {
            Message::Text(text) => text.to_string(),
            Message::Binary(bytes) => String::from_utf8(bytes.to_vec()).map_err(|err| {
                AppError::Operation(format!("browser snapshot response was not utf-8: {err}"))
            })?,
            Message::Close(_) => break,
            _ => continue,
        };
        let response: CdpResponse<CdpEvaluateResult> =
            serde_json::from_str(&raw).map_err(|err| {
                AppError::Operation(format!("failed to parse browser snapshot response: {err}"))
            })?;
        if response.id != Some(1) {
            continue;
        }
        if let Some(error) = response.error {
            return Err(AppError::Operation(
                error
                    .data
                    .or(error.message)
                    .unwrap_or_else(|| "browser snapshot command failed".into()),
            ));
        }
        let result = response
            .result
            .ok_or_else(|| AppError::Operation("browser snapshot response was empty".into()))?;
        if let Some(details) = result.exception_details {
            return Err(AppError::Operation(cdp_exception_message(details)));
        }
        return Ok(result
            .result
            .and_then(|object| object.value)
            .unwrap_or(Value::Null));
    }

    Err(AppError::Operation(
        "browser snapshot websocket closed before a response".into(),
    ))
}

fn snapshot_page_from_value(value: Value) -> Result<BrowserSnapshotPage, AppError> {
    serde_json::from_value(value)
        .map_err(|err| AppError::Operation(format!("failed to normalize browser snapshot: {err}")))
}

async fn capture_browser_snapshot(
    context: &BrowserContext,
    tab_id: Option<String>,
) -> Result<BrowserSnapshot, AppError> {
    if context.status == "closed" {
        return Err(AppError::Operation("browser context is closed".into()));
    }

    let body = cdp_get_body(&context.host, context.port, "/json/list")?;
    let raw_tabs = parse_cdp_tab_list(&body)?;
    let selected = tab_id
        .as_deref()
        .and_then(|id| raw_tabs.iter().find(|tab| tab.id == id))
        .or_else(|| {
            raw_tabs
                .iter()
                .find(|tab| tab.tab_type == "page" && tab.web_socket_debugger_url.is_some())
        })
        .or_else(|| {
            raw_tabs
                .iter()
                .find(|tab| tab.web_socket_debugger_url.is_some())
        })
        .ok_or_else(|| AppError::Operation("browser tab does not expose a CDP socket".into()))?;
    let web_socket_url = selected
        .web_socket_debugger_url
        .as_deref()
        .ok_or_else(|| AppError::Operation("browser tab does not expose a CDP socket".into()))?;
    let value = cdp_evaluate_value(
        web_socket_url,
        build_browser_snapshot_expression(24_000, 120),
    )
    .await?;
    let page = snapshot_page_from_value(value)?;

    Ok(BrowserSnapshot {
        id: Uuid::new_v4().to_string(),
        scope: context.scope.clone(),
        context_id: context.id.clone(),
        tab_id: selected.id.clone(),
        url: if page.url.is_empty() {
            selected.url.clone()
        } else {
            page.url
        },
        title: if page.title.is_empty() {
            selected.title.clone()
        } else {
            page.title
        },
        text: page.text,
        elements: page.elements,
        screenshot_path: None,
        created_by: None,
        created_at: unix_millis_i64() / 1000,
    })
}

fn refresh_browser_context_tabs(context: &BrowserContext) -> Result<Vec<BrowserTab>, AppError> {
    if context.status == "closed" {
        return Ok(Vec::new());
    }

    let updated_at = unix_millis_i64() / 1000;
    let body = cdp_get_body(&context.host, context.port, "/json/list")?;
    let tabs = parse_cdp_tabs(&context.scope, &context.id, &body, updated_at)?;
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::record_browser_tabs(&conn, &context.scope, &context.id, &tabs, updated_at)
        .map_err(AppError::Operation)
}

fn refresh_browser_context_for_catalog(context: &BrowserContext) -> Result<(), AppError> {
    if context.status == "closed" {
        return Ok(());
    }

    match refresh_browser_context_tabs(context) {
        Ok(_) => Ok(()),
        Err(err) => {
            if context.pid.is_some_and(|pid| !browser_pid_alive(pid)) {
                let conn = writes::open_rw().map_err(AppError::Operation)?;
                writes::close_browser_context(
                    &conn,
                    &context.scope,
                    &context.id,
                    unix_millis_i64() / 1000,
                )
                .map_err(AppError::Operation)?;
                Ok(())
            } else {
                Err(err)
            }
        }
    }
}

fn resolve_project_root_path(raw: &str) -> Result<PathBuf, AppError> {
    let trimmed = trim_required(raw, "project root")?;
    if trimmed == "~" {
        return dirs::home_dir()
            .ok_or_else(|| AppError::Operation("failed to resolve home directory".into()));
    }

    if let Some(rest) = trimmed.strip_prefix("~/") {
        return dirs::home_dir()
            .map(|home| home.join(rest))
            .ok_or_else(|| AppError::Operation("failed to resolve home directory".into()));
    }

    let path = PathBuf::from(&trimmed);
    if !path.is_absolute() {
        return Err(AppError::Validation(
            "project root must be an absolute path".into(),
        ));
    }
    Ok(path)
}

fn normalize_project_color(value: &str) -> String {
    let trimmed = value.trim();
    let hex = trimmed.strip_prefix('#').unwrap_or(trimmed);
    let valid_length = hex.len() == 3 || hex.len() == 6;
    if valid_length && hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        format!("#{}", hex.to_ascii_lowercase())
    } else {
        "#ffffff".into()
    }
}

fn normalize_project_boundary(boundary: ProjectBoundary) -> ProjectBoundary {
    ProjectBoundary {
        x: if boundary.x.is_finite() {
            boundary.x
        } else {
            120.0
        },
        y: if boundary.y.is_finite() {
            boundary.y
        } else {
            120.0
        },
        width: if boundary.width.is_finite() {
            boundary.width.max(320.0)
        } else {
            720.0
        },
        height: if boundary.height.is_finite() {
            boundary.height.max(220.0)
        } else {
            420.0
        },
    }
}

fn normalize_project_payload(project: ProjectSpace) -> Result<ProjectSpace, AppError> {
    let id = trim_required(&project.id, "project id")?;
    let name = trim_required(&project.name, "project name")?;
    let root = resolve_project_root_path(&project.root)?
        .to_string_lossy()
        .into_owned();

    let now = unix_millis_i64();
    Ok(ProjectSpace {
        id,
        name,
        root,
        color: normalize_project_color(&project.color),
        additional_roots: project
            .additional_roots
            .into_iter()
            .map(|entry| entry.trim().to_owned())
            .filter(|entry| !entry.is_empty())
            .collect(),
        notes: project.notes.trim().to_owned(),
        scope: normalize_optional(project.scope),
        boundary: normalize_project_boundary(project.boundary),
        created_at: if project.created_at > 0 {
            project.created_at
        } else {
            now
        },
        updated_at: if project.updated_at > 0 {
            project.updated_at
        } else {
            now
        },
    })
}

fn normalize_asset_payload(asset: ProjectAsset) -> Result<ProjectAsset, AppError> {
    let id = trim_required(&asset.id, "asset id")?;
    let project_id = trim_required(&asset.project_id, "project id")?;
    let kind = trim_required(&asset.kind, "asset kind")?;
    if !ASSET_KINDS.contains(&kind.as_str()) {
        return Err(AppError::Validation(format!(
            "unsupported asset kind: {kind}"
        )));
    }
    let title = trim_required(&asset.title, "asset title")?;
    let now = unix_millis_i64();

    let normalized = ProjectAsset {
        id,
        project_id,
        kind,
        title,
        path: normalize_optional(asset.path),
        content: normalize_optional(asset.content),
        description: asset.description.trim().to_owned(),
        created_at: if asset.created_at > 0 {
            asset.created_at
        } else {
            now
        },
        updated_at: if asset.updated_at > 0 {
            asset.updated_at
        } else {
            now
        },
    };

    validate_asset_payload(&normalized)?;
    Ok(normalized)
}

fn validate_asset_payload(asset: &ProjectAsset) -> Result<(), AppError> {
    match asset.kind.as_str() {
        "image" | "screenshot" => {
            let path = asset
                .path
                .as_deref()
                .ok_or_else(|| AppError::Validation("visual assets require a file path".into()))?;
            let path_buf = validate_local_asset_path(path, "visual asset path")?;
            let metadata = path_buf.metadata().map_err(|err| {
                AppError::Validation(format!("visual asset path is not readable: {err}"))
            })?;
            if !metadata.is_file() {
                return Err(AppError::Validation(
                    "visual asset path must point to a file".into(),
                ));
            }
            let extension = path_buf
                .extension()
                .and_then(|entry| entry.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !IMAGE_EXTENSIONS.contains(&extension.as_str()) {
                return Err(AppError::Validation(format!(
                    "unsupported visual asset extension: {extension}"
                )));
            }
        }
        "folder" => {
            let path = asset.path.as_deref().ok_or_else(|| {
                AppError::Validation("folder assets require a directory path".into())
            })?;
            let path_buf = validate_local_asset_path(path, "folder asset path")?;
            let metadata = path_buf.metadata().map_err(|err| {
                AppError::Validation(format!("folder asset path is not readable: {err}"))
            })?;
            if !metadata.is_dir() {
                return Err(AppError::Validation(
                    "folder asset path must point to a directory".into(),
                ));
            }
        }
        "note" | "protocol" => {
            if asset.path.is_none() && asset.content.is_none() {
                return Err(AppError::Validation(format!(
                    "{} assets require content or a file path",
                    asset.kind
                )));
            }
            if let Some(path) = asset.path.as_deref() {
                validate_text_asset_path(path)?;
            }
        }
        "reference" => {
            if asset.path.is_none() && asset.description.trim().is_empty() {
                return Err(AppError::Validation(
                    "reference assets require a link/path or description".into(),
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_local_asset_path(path: &str, label: &str) -> Result<PathBuf, AppError> {
    let path_buf = PathBuf::from(path);
    if !path_buf.is_absolute() {
        return Err(AppError::Validation(format!("{label} must be absolute")));
    }
    Ok(path_buf)
}

fn validate_text_asset_path(path: &str) -> Result<PathBuf, AppError> {
    let path_buf = validate_local_asset_path(path, "text asset path")?;
    let metadata = path_buf
        .metadata()
        .map_err(|err| AppError::Validation(format!("text asset path is not readable: {err}")))?;
    if !metadata.is_file() {
        return Err(AppError::Validation(
            "text asset path must point to a file".into(),
        ));
    }
    let extension = extension_for_path(&path_buf);
    if !TEXT_EXTENSIONS.contains(&extension.as_str()) {
        return Err(AppError::Validation(format!(
            "unsupported text asset extension: {extension}"
        )));
    }
    Ok(path_buf)
}

fn read_text_asset_content(path: &Path) -> Result<String, AppError> {
    let mut file = fs::File::open(path)
        .map_err(|err| AppError::Validation(format!("text asset path is not readable: {err}")))?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_TEXT_ASSET_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| AppError::Validation(format!("failed to read text asset: {err}")))?;
    let truncated = bytes.len() > MAX_TEXT_ASSET_BYTES as usize;
    if truncated {
        bytes.truncate(MAX_TEXT_ASSET_BYTES as usize);
    }
    let mut content = String::from_utf8(bytes)
        .map_err(|err| AppError::Validation(format!("text asset is not valid UTF-8: {err}")))?;
    if extension_for_path(path) == "rtf" {
        content = strip_rtf_markup(&content);
    }
    if truncated {
        content.push_str("\n\n[Truncated to first 32000 bytes.]");
    }
    Ok(content)
}

fn write_text_asset_content(path: &Path, content: &str) -> Result<String, AppError> {
    if content.as_bytes().len() > MAX_TEXT_ASSET_BYTES as usize {
        return Err(AppError::Validation(format!(
            "text asset content exceeds {} bytes",
            MAX_TEXT_ASSET_BYTES
        )));
    }
    let mut body = content.to_owned();
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }
    fs::write(path, &body).map_err(|err| {
        AppError::Operation(format!(
            "failed to write text asset {}: {err}",
            path.display()
        ))
    })?;
    Ok(body)
}

fn strip_rtf_markup(raw: &str) -> String {
    let mut out = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '{' | '}' => {}
            '\\' => {
                let Some(next) = chars.peek().copied() else {
                    break;
                };
                if matches!(next, '\\' | '{' | '}') {
                    out.push(next);
                    chars.next();
                    continue;
                }
                if next == '\'' {
                    chars.next();
                    let hex = [chars.next(), chars.next()];
                    if let [Some(left), Some(right)] = hex {
                        let value = format!("{left}{right}");
                        if let Ok(byte) = u8::from_str_radix(&value, 16) {
                            out.push(char::from(byte));
                        }
                    }
                    continue;
                }

                let mut control = String::new();
                while let Some(peek) = chars.peek().copied() {
                    if peek.is_ascii_alphabetic() {
                        control.push(peek);
                        chars.next();
                    } else {
                        break;
                    }
                }
                if matches!(chars.peek(), Some('-')) {
                    chars.next();
                }
                while let Some(peek) = chars.peek().copied() {
                    if peek.is_ascii_digit() {
                        chars.next();
                    } else {
                        break;
                    }
                }
                if matches!(chars.peek(), Some(' ')) {
                    chars.next();
                }
                match control.as_str() {
                    "par" | "line" => out.push('\n'),
                    "tab" => out.push('\t'),
                    "emdash" | "endash" => out.push('-'),
                    "bullet" => out.push('*'),
                    _ => {}
                }
            }
            '\r' | '\n' => {}
            _ => out.push(ch),
        }
    }
    out.lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

fn hydrate_text_asset_content(asset: &mut ProjectAsset) -> Result<(), AppError> {
    if asset.content.is_some() || !matches!(asset.kind.as_str(), "note" | "protocol") {
        return Ok(());
    }
    let Some(path) = asset.path.as_deref() else {
        return Ok(());
    };
    let path_buf = validate_text_asset_path(path)?;
    asset.content = Some(read_text_asset_content(&path_buf)?);
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VisualAnalyzerInput<'a> {
    asset_id: &'a str,
    project_id: &'a str,
    kind: &'a str,
    title: &'a str,
    path: &'a str,
    description: &'a str,
    prompt: String,
}

fn visual_analysis_prompt(asset: &ProjectAsset) -> String {
    [
        "Analyze this project visual asset for coding agents.",
        "Return concise, practical context, not prose flourish.",
        "Include: visible UI/layout/text, important objects, colors/style, likely purpose, issues or risks, and OCR text if present.",
        "If this is a screenshot, describe the visible state and any error or empty-state cues.",
        "Keep it under 220 words so it can be injected into agent context.",
        &format!("Asset title: {}", asset.title),
        &format!("Existing description: {}", asset.description),
    ]
    .join("\n")
}

fn visual_asset_path(asset: &ProjectAsset) -> Result<PathBuf, AppError> {
    if !matches!(asset.kind.as_str(), "image" | "screenshot") {
        return Err(AppError::Validation(
            "only image and screenshot assets can be analyzed".into(),
        ));
    }
    let path = asset
        .path
        .as_deref()
        .ok_or_else(|| AppError::Validation("visual analysis requires a file path".into()))?;
    let path_buf = validate_local_asset_path(path, "visual analysis path")?;
    let metadata = path_buf.metadata().map_err(|err| {
        AppError::Validation(format!("visual analysis path is not readable: {err}"))
    })?;
    if !metadata.is_file() {
        return Err(AppError::Validation(
            "visual analysis path must point to a file".into(),
        ));
    }
    if metadata.len() > MAX_ANALYSIS_IMAGE_BYTES {
        return Err(AppError::Validation(format!(
            "visual analysis image is too large: {} bytes exceeds {}",
            metadata.len(),
            MAX_ANALYSIS_IMAGE_BYTES
        )));
    }
    let extension = extension_for_path(&path_buf);
    if !IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(AppError::Validation(format!(
            "unsupported visual analysis extension: {extension}"
        )));
    }
    Ok(path_buf)
}

fn mime_for_image_path(path: &Path) -> &'static str {
    match extension_for_path(path).as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" | "heif" => "image/heic",
        "svg" => "image/svg+xml",
        _ => "image/png",
    }
}

fn asset_analyzer_config_path() -> Result<PathBuf, AppError> {
    dirs::config_dir()
        .map(|path| path.join("swarm-ui").join(ASSET_ANALYZER_CONFIG_FILE))
        .ok_or_else(|| AppError::Operation("failed to resolve app config directory".into()))
}

fn load_asset_analyzer_config() -> AssetAnalyzerConfig {
    let Ok(path) = asset_analyzer_config_path() else {
        return AssetAnalyzerConfig::default();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return AssetAnalyzerConfig::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_asset_analyzer_config(config: &AssetAnalyzerConfig) -> Result<(), AppError> {
    let path = asset_analyzer_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            AppError::Operation(format!(
                "failed to create asset analyzer config directory {}: {err}",
                parent.display()
            ))
        })?;
    }
    let raw = serde_json::to_string_pretty(config)
        .map_err(|err| AppError::Internal(format!("failed to encode analyzer config: {err}")))?;
    fs::write(&path, format!("{raw}\n")).map_err(|err| {
        AppError::Operation(format!(
            "failed to write asset analyzer config {}: {err}",
            path.display()
        ))
    })
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|entry| entry.trim().to_owned())
        .filter(|entry| !entry.is_empty())
}

fn read_shell_env_var(name: &str) -> Option<String> {
    if !name.chars().all(|ch| ch.is_ascii_uppercase() || ch == '_') {
        return None;
    }
    let output = Command::new("/bin/zsh")
        .arg("-lc")
        .arg(format!("printenv {name}"))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    non_empty(Some(String::from_utf8_lossy(&output.stdout).into_owned()))
}

fn read_keychain_openai_api_key() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let output = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            ASSET_ANALYZER_KEYCHAIN_SERVICE,
            "-a",
            ASSET_ANALYZER_OPENAI_ACCOUNT,
            "-w",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    non_empty(Some(String::from_utf8_lossy(&output.stdout).into_owned()))
}

fn write_keychain_openai_api_key(api_key: &str) -> Result<(), AppError> {
    if !cfg!(target_os = "macos") {
        return Err(AppError::Operation(
            "saving OpenAI API keys is currently supported on macOS only".into(),
        ));
    }
    let output = Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            ASSET_ANALYZER_KEYCHAIN_SERVICE,
            "-a",
            ASSET_ANALYZER_OPENAI_ACCOUNT,
            "-w",
            api_key,
        ])
        .output()
        .map_err(|err| AppError::Operation(format!("failed to run macOS Keychain: {err}")))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(AppError::Operation(format!(
        "failed to save OpenAI API key in macOS Keychain: {}",
        stderr.trim()
    )))
}

fn delete_keychain_openai_api_key() -> Result<(), AppError> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let output = Command::new("/usr/bin/security")
        .args([
            "delete-generic-password",
            "-s",
            ASSET_ANALYZER_KEYCHAIN_SERVICE,
            "-a",
            ASSET_ANALYZER_OPENAI_ACCOUNT,
        ])
        .output()
        .map_err(|err| AppError::Operation(format!("failed to run macOS Keychain: {err}")))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("could not be found")
        || stderr.contains("The specified item could not be found")
    {
        return Ok(());
    }
    Err(AppError::Operation(format!(
        "failed to clear OpenAI API key from macOS Keychain: {}",
        stderr.trim()
    )))
}

fn configured_analyzer_command(config: &AssetAnalyzerConfig) -> Option<String> {
    non_empty(std::env::var("SWARM_ASSET_ANALYZER_CMD").ok())
        .or_else(|| non_empty(config.custom_command.clone()))
        .or_else(|| read_shell_env_var("SWARM_ASSET_ANALYZER_CMD"))
}

fn configured_openai_api_key() -> Option<String> {
    non_empty(std::env::var("OPENAI_API_KEY").ok())
        .or_else(read_keychain_openai_api_key)
        .or_else(|| read_shell_env_var("OPENAI_API_KEY"))
}

fn configured_openai_model(config: &AssetAnalyzerConfig) -> Option<String> {
    non_empty(std::env::var("OPENAI_VISION_MODEL").ok())
        .or_else(|| non_empty(config.openai_model.clone()))
        .or_else(|| read_shell_env_var("OPENAI_VISION_MODEL"))
}

fn asset_analyzer_settings_from_config(config: AssetAnalyzerConfig) -> AssetAnalyzerSettings {
    AssetAnalyzerSettings {
        openai_configured: configured_openai_api_key().is_some(),
        openai_model: configured_openai_model(&config)
            .unwrap_or_else(|| DEFAULT_OPENAI_VISION_MODEL.to_owned()),
        custom_command: configured_analyzer_command(&config).unwrap_or_default(),
        config_path: asset_analyzer_config_path()
            .ok()
            .map(|path| path.to_string_lossy().into_owned()),
    }
}

fn run_visual_analysis(asset: &ProjectAsset, path: &Path) -> Result<String, AppError> {
    let config = load_asset_analyzer_config();
    if let Some(command) = configured_analyzer_command(&config) {
        return run_external_visual_analyzer(asset, path, &command);
    }

    if let Some(api_key) = configured_openai_api_key() {
        return run_openai_visual_analyzer(
            asset,
            path,
            api_key.trim(),
            configured_openai_model(&config).as_deref(),
        );
    }

    Err(AppError::Validation(
        "No multimodal analyzer configured. Add an OpenAI API key in Settings > Multimodal Analyzer, set OPENAI_API_KEY for the app process, or set SWARM_ASSET_ANALYZER_CMD for a local/custom analyzer.".into(),
    ))
}

fn run_external_visual_analyzer(
    asset: &ProjectAsset,
    path: &Path,
    command: &str,
) -> Result<String, AppError> {
    let path_text = path.to_string_lossy().into_owned();
    let input = VisualAnalyzerInput {
        asset_id: &asset.id,
        project_id: &asset.project_id,
        kind: &asset.kind,
        title: &asset.title,
        path: &path_text,
        description: &asset.description,
        prompt: visual_analysis_prompt(asset),
    };
    let input_json = serde_json::to_vec(&input)
        .map_err(|err| AppError::Internal(format!("failed to encode analyzer input: {err}")))?;
    let mut child = Command::new("/bin/zsh")
        .arg("-lc")
        .arg(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| AppError::Operation(format!("failed to spawn visual analyzer: {err}")))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(&input_json)
            .map_err(|err| AppError::Operation(format!("failed to write analyzer input: {err}")))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|err| AppError::Operation(format!("visual analyzer failed: {err}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Operation(format!(
            "visual analyzer exited with {}: {}",
            output.status,
            stderr.trim()
        )));
    }

    let stdout = String::from_utf8(output.stdout).map_err(|err| {
        AppError::Operation(format!("visual analyzer returned non-UTF-8 output: {err}"))
    })?;
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err(AppError::Operation(
            "visual analyzer returned empty output".into(),
        ));
    }

    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if let Some(analysis) = value.get("analysis").and_then(Value::as_str) {
            let trimmed = analysis.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_owned());
            }
        }
    }

    Ok(trimmed.to_owned())
}

fn run_openai_visual_analyzer(
    asset: &ProjectAsset,
    path: &Path,
    api_key: &str,
    model_override: Option<&str>,
) -> Result<String, AppError> {
    let extension = extension_for_path(path);
    if !OPENAI_IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(AppError::Validation(format!(
            "OpenAI visual analysis supports png, jpg, jpeg, gif, and webp. Use SWARM_ASSET_ANALYZER_CMD for .{extension} assets or convert the image first."
        )));
    }
    let image_bytes = fs::read(path).map_err(|err| {
        AppError::Validation(format!("visual analysis path is not readable: {err}"))
    })?;
    let encoded = general_purpose::STANDARD.encode(image_bytes);
    let mime = mime_for_image_path(path);
    let model = model_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| DEFAULT_OPENAI_VISION_MODEL.to_owned());
    let body = json!({
        "model": model,
        "input": [{
            "role": "user",
            "content": [
                { "type": "input_text", "text": visual_analysis_prompt(asset) },
                {
                    "type": "input_image",
                    "image_url": format!("data:{mime};base64,{encoded}"),
                    "detail": "high"
                }
            ]
        }],
        "max_output_tokens": 700
    });

    let mut child = Command::new("/usr/bin/curl")
        .arg("-sS")
        .arg("https://api.openai.com/v1/responses")
        .arg("-H")
        .arg("Content-Type: application/json")
        .arg("-H")
        .arg(format!("Authorization: Bearer {api_key}"))
        .arg("--data-binary")
        .arg("@-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| {
            AppError::Operation(format!("failed to run OpenAI visual analyzer: {err}"))
        })?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(body.to_string().as_bytes())
            .map_err(|err| {
                AppError::Operation(format!("failed to write OpenAI request body: {err}"))
            })?;
    }

    let output = child
        .wait_with_output()
        .map_err(|err| AppError::Operation(format!("OpenAI visual analyzer failed: {err}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Operation(format!(
            "OpenAI visual analyzer exited with {}: {}",
            output.status,
            stderr.trim()
        )));
    }

    let response_text = String::from_utf8(output.stdout)
        .map_err(|err| AppError::Operation(format!("OpenAI response was not UTF-8: {err}")))?;
    let value: Value = serde_json::from_str(&response_text)
        .map_err(|err| AppError::Operation(format!("OpenAI response was not JSON: {err}")))?;
    if let Some(message) = value
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
    {
        return Err(AppError::Operation(format!(
            "OpenAI visual analyzer error: {message}"
        )));
    }
    extract_response_text(&value)
        .ok_or_else(|| AppError::Operation("OpenAI response did not include output text".into()))
}

fn extract_response_text(value: &Value) -> Option<String> {
    fn walk(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                if map.get("type").and_then(Value::as_str) == Some("output_text") {
                    if let Some(text) = map.get("text").and_then(Value::as_str) {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            out.push(trimmed.to_owned());
                        }
                    }
                }
                for child in map.values() {
                    walk(child, out);
                }
            }
            Value::Array(entries) => {
                for entry in entries {
                    walk(entry, out);
                }
            }
            _ => {}
        }
    }

    if let Some(text) = value.get("output_text").and_then(Value::as_str) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_owned());
        }
    }

    let mut parts = Vec::new();
    walk(value, &mut parts);
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

fn analyze_project_asset_with_runner<F>(
    conn: &rusqlite::Connection,
    asset_id: &str,
    runner: F,
) -> Result<ProjectAsset, AppError>
where
    F: FnOnce(&ProjectAsset, &Path) -> Result<String, AppError>,
{
    let id = trim_required(asset_id, "asset id")?;
    let mut asset = writes::load_project_asset(conn, &id)
        .map_err(AppError::Operation)?
        .ok_or_else(|| AppError::NotFound(format!("project asset not found: {id}")))?;
    let project = writes::load_project(conn, &asset.project_id)
        .map_err(AppError::Operation)?
        .ok_or_else(|| AppError::NotFound(format!("project not found: {}", asset.project_id)))?;
    let path = visual_asset_path(&asset)?;
    let analysis = runner(&asset, &path)?.trim().to_owned();
    if analysis.is_empty() {
        return Err(AppError::Operation(
            "visual analyzer returned empty analysis".into(),
        ));
    }
    asset.content = Some(analysis);
    asset.updated_at = unix_millis_i64();
    write_visual_analysis_workspace_artifact(
        &project,
        &asset,
        asset.content.as_deref().unwrap_or_default(),
    )?;
    writes::save_project_asset(conn, &asset).map_err(AppError::Operation)
}

fn extension_for_path(path: &Path) -> String {
    path.extension()
        .and_then(|entry| entry.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn title_for_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|entry| entry.to_str())
        .filter(|entry| !entry.trim().is_empty())
        .unwrap_or("Untitled asset")
        .trim()
        .to_owned()
}

fn asset_kind_for_file(path: &Path) -> Option<String> {
    let extension = extension_for_path(path);
    if IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Some("image".into());
    }
    if TEXT_EXTENSIONS.contains(&extension.as_str()) {
        let stem = title_for_path(path).to_ascii_lowercase();
        if stem.contains("protocol") || stem.contains("runbook") || stem.contains("procedure") {
            return Some("protocol".into());
        }
        return Some("note".into());
    }
    None
}

fn stable_asset_id(project_id: &str, path: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in project_id.bytes().chain([0]).chain(path.bytes()) {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("asset-{hash:016x}")
}

fn current_local_date_slug() -> String {
    let output = Command::new("/bin/date").arg("+%Y-%m-%d").output();
    output
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| {
            value.len() == 10 && value.chars().all(|ch| ch.is_ascii_digit() || ch == '-')
        })
        .unwrap_or_else(|| "undated".into())
}

fn sanitize_filename_component(value: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in value.trim().chars() {
        let next = if ch.is_ascii_alphanumeric() {
            last_dash = false;
            Some(ch.to_ascii_lowercase())
        } else if matches!(ch, '-' | '_') {
            last_dash = false;
            Some(ch)
        } else if !last_dash {
            last_dash = true;
            Some('-')
        } else {
            None
        };
        if let Some(ch) = next {
            out.push(ch);
        }
    }
    let trimmed = out.trim_matches('-').to_owned();
    if trimmed.is_empty() {
        "asset".into()
    } else {
        trimmed.chars().take(80).collect()
    }
}

fn ensure_project_workspace(project: &ProjectSpace) -> Result<PathBuf, AppError> {
    let root = resolve_project_root_path(&project.root)?;
    fs::create_dir_all(&root).map_err(|err| {
        AppError::Operation(format!(
            "failed to create project root {}: {err}",
            root.display()
        ))
    })?;
    let workspace = root.join(PROJECT_WORKSPACE_DIR);
    fs::create_dir_all(&workspace).map_err(|err| {
        AppError::Operation(format!(
            "failed to create project workspace {}: {err}",
            workspace.display()
        ))
    })?;

    let readme = workspace.join("README.md");
    if !readme.exists() {
        let content = format!(
            "# Project Workspace\n\nThis folder stores working notes, plans, generated analysis, and temporary project artifacts for `{}`.\n\n- Keep durable/important project notes directly in this folder.\n- Put daily scratch plans, temporary actions, and non-critical notes in dated folders like `{}`.\n- Generated visual analysis files are written into the dated folder for the day they were produced.\n",
            project.name,
            current_local_date_slug()
        );
        fs::write(&readme, content).map_err(|err| {
            AppError::Operation(format!(
                "failed to write project workspace README {}: {err}",
                readme.display()
            ))
        })?;
    }

    Ok(workspace)
}

fn write_visual_analysis_workspace_artifact(
    project: &ProjectSpace,
    asset: &ProjectAsset,
    analysis: &str,
) -> Result<PathBuf, AppError> {
    let workspace = ensure_project_workspace(project)?;
    let day_dir = workspace.join(current_local_date_slug());
    fs::create_dir_all(&day_dir).map_err(|err| {
        AppError::Operation(format!(
            "failed to create project workspace day folder {}: {err}",
            day_dir.display()
        ))
    })?;

    let asset_slug = sanitize_filename_component(&asset.title);
    let id_suffix: String = asset
        .id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(8)
        .collect();
    let suffix = if id_suffix.is_empty() {
        "asset".into()
    } else {
        id_suffix
    };
    let path = day_dir.join(format!("visual-analysis-{asset_slug}-{suffix}.md"));
    let source_path = asset.path.as_deref().unwrap_or("none");
    let content = format!(
        "# Visual Analysis - {title}\n\nProject: {project_name}\nAsset ID: {asset_id}\nAsset kind: {kind}\nSource path: {source_path}\n\n## Analysis\n\n{analysis}\n",
        title = asset.title,
        project_name = project.name,
        asset_id = asset.id,
        kind = asset.kind,
    );
    fs::write(&path, content).map_err(|err| {
        AppError::Operation(format!(
            "failed to write visual analysis artifact {}: {err}",
            path.display()
        ))
    })?;
    Ok(path)
}

fn write_project_note_asset_record(
    conn: &rusqlite::Connection,
    project_id: &str,
    title: &str,
    content: Option<String>,
) -> Result<ProjectAsset, AppError> {
    let id = trim_required(project_id, "project id")?;
    let title = title
        .trim()
        .chars()
        .take(120)
        .collect::<String>()
        .trim()
        .to_owned();
    let title = if title.is_empty() {
        "Canvas Note".to_owned()
    } else {
        title
    };
    let project = writes::load_project(conn, &id)
        .map_err(AppError::Operation)?
        .ok_or_else(|| AppError::NotFound(format!("project {id} not found")))?;
    let workspace = ensure_project_workspace(&project)?;
    let now = unix_millis_i64();
    let slug = sanitize_filename_component(&title);
    let path = workspace.join(format!(
        "note-{}-{now}-{slug}.md",
        current_local_date_slug()
    ));
    let mut body = content
        .as_deref()
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("# {title}\n\n"));
    if !body.ends_with('\n') {
        body.push('\n');
    }
    fs::write(&path, &body).map_err(|err| {
        AppError::Operation(format!(
            "failed to write project note {}: {err}",
            path.display()
        ))
    })?;

    let path_text = path.to_string_lossy().into_owned();
    let asset = ProjectAsset {
        id: stable_asset_id(&project.id, &path_text),
        project_id: project.id,
        kind: "note".into(),
        title,
        path: Some(path_text),
        content: Some(body),
        description: "Canvas note".into(),
        created_at: now,
        updated_at: now,
    };
    writes::save_project_asset(conn, &asset).map_err(AppError::Operation)
}

fn write_project_text_asset_content(
    conn: &rusqlite::Connection,
    asset_id: &str,
    content: &str,
) -> Result<ProjectAsset, AppError> {
    let id = trim_required(asset_id, "asset id")?;
    let mut asset = writes::load_project_asset(conn, &id)
        .map_err(AppError::Operation)?
        .ok_or_else(|| AppError::NotFound(format!("asset {id} not found")))?;
    if asset.kind != "note" && asset.kind != "protocol" {
        return Err(AppError::Validation(format!(
            "asset {} is not editable text",
            asset.id
        )));
    }
    let path = asset
        .path
        .as_deref()
        .ok_or_else(|| AppError::Validation("text asset has no file path".into()))?;
    let path_buf = validate_text_asset_path(path)?;
    let body = write_text_asset_content(&path_buf, content)?;
    asset.content = if body.trim().is_empty() {
        None
    } else {
        Some(body)
    };
    asset.updated_at = unix_millis_i64();
    writes::save_project_asset(conn, &asset).map_err(AppError::Operation)
}

fn project_asset_root_paths(project: &ProjectSpace) -> Vec<PathBuf> {
    let mut roots = Vec::with_capacity(project.additional_roots.len() + 1);
    roots.push(PathBuf::from(&project.root));
    roots.extend(project.additional_roots.iter().map(PathBuf::from));
    roots
}

fn project_asset_scanned_roots(project: &ProjectSpace) -> Vec<String> {
    project_asset_root_paths(project)
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

fn project_inventory_entries(
    project: &ProjectSpace,
) -> Result<Vec<ProjectInventoryEntry>, AppError> {
    let mut entries = Vec::new();
    for root in project_asset_root_paths(project) {
        if entries.len() >= MAX_PROJECT_INVENTORY_ENTRIES {
            break;
        }
        if !root.is_dir() {
            continue;
        }
        scan_project_inventory_root(project, &root, &root, 0, &mut entries)?;
    }
    entries.sort_by(|left, right| {
        let left_rank = if left.entry_type == "folder" { 0 } else { 1 };
        let right_rank = if right.entry_type == "folder" { 0 } else { 1 };
        left_rank
            .cmp(&right_rank)
            .then_with(|| {
                left.name
                    .to_ascii_lowercase()
                    .cmp(&right.name.to_ascii_lowercase())
            })
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(entries)
}

fn scan_project_inventory_root(
    project: &ProjectSpace,
    root: &Path,
    directory: &Path,
    depth: usize,
    entries: &mut Vec<ProjectInventoryEntry>,
) -> Result<(), AppError> {
    let root_text = root.to_string_lossy().into_owned();
    let rows = fs::read_dir(directory).map_err(|err| {
        AppError::Operation(format!(
            "failed to read project inventory root {}: {err}",
            directory.display()
        ))
    })?;

    for row in rows {
        if entries.len() >= MAX_PROJECT_INVENTORY_ENTRIES {
            break;
        }
        let row = row.map_err(|err| {
            AppError::Operation(format!(
                "failed to read project inventory entry in {}: {err}",
                directory.display()
            ))
        })?;
        let name = row.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = row.path();
        let file_type = row.file_type().map_err(|err| {
            AppError::Operation(format!(
                "failed to read project inventory entry type {}: {err}",
                path.display()
            ))
        })?;
        let metadata = row.metadata().ok();
        let entry_type = if file_type.is_dir() {
            "folder"
        } else if file_type.is_file() {
            "file"
        } else if file_type.is_symlink() {
            "symlink"
        } else {
            "other"
        };
        let extension = extension_for_path(&path);
        let is_dir = file_type.is_dir();
        entries.push(ProjectInventoryEntry {
            project_id: project.id.clone(),
            root: root_text.clone(),
            path: path.to_string_lossy().into_owned(),
            name,
            entry_type: entry_type.into(),
            category: inventory_category(entry_type, &extension).into(),
            extension,
            size_bytes: metadata.as_ref().and_then(|meta| {
                if meta.is_file() {
                    Some(meta.len())
                } else {
                    None
                }
            }),
            modified_at: metadata
                .and_then(|meta| meta.modified().ok())
                .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
                .and_then(|duration| i64::try_from(duration.as_millis()).ok())
                .unwrap_or_default(),
        });
        if is_dir && depth < MAX_PROJECT_INVENTORY_DEPTH {
            scan_project_inventory_root(project, root, &path, depth + 1, entries)?;
        }
    }
    Ok(())
}

fn inventory_category(entry_type: &str, extension: &str) -> &'static str {
    if entry_type == "folder" {
        return "folder";
    }
    if IMAGE_EXTENSIONS.contains(&extension) {
        return "image";
    }
    if extension == "rtf" {
        return "richText";
    }
    if matches!(
        extension,
        "txt" | "md" | "markdown" | "json" | "yaml" | "yml"
    ) {
        return "text";
    }
    if matches!(
        extension,
        "swift" | "rs" | "ts" | "tsx" | "js" | "jsx" | "svelte" | "py"
    ) {
        return "code";
    }
    if matches!(extension, "pdf" | "doc" | "docx" | "pages") {
        return "document";
    }
    if matches!(extension, "zip" | "tar" | "gz" | "7z") {
        return "archive";
    }
    if matches!(extension, "mp4" | "mov" | "mp3" | "wav" | "m4a") {
        return "media";
    }
    match entry_type {
        "file" => "file",
        "symlink" => "symlink",
        _ => "other",
    }
}

fn discover_project_asset_candidates(
    project: &ProjectSpace,
    existing_assets: &[ProjectAsset],
) -> Result<Vec<ProjectAsset>, AppError> {
    let mut seen_paths: HashSet<String> = existing_assets
        .iter()
        .filter_map(|asset| asset.path.as_deref())
        .map(ToOwned::to_owned)
        .collect();
    let mut candidates = Vec::new();
    let now = unix_millis_i64();

    for root in project_asset_root_paths(project) {
        if candidates.len() >= MAX_DISCOVERED_ASSETS {
            break;
        }
        if !root.is_dir() {
            continue;
        }
        scan_asset_directory(&project.id, &root, 0, &mut seen_paths, &mut candidates, now)?;
    }

    candidates.sort_by(|left, right| left.title.cmp(&right.title));
    Ok(candidates)
}

fn scan_asset_directory(
    project_id: &str,
    directory: &Path,
    depth: usize,
    seen_paths: &mut HashSet<String>,
    candidates: &mut Vec<ProjectAsset>,
    now: i64,
) -> Result<(), AppError> {
    if depth > MAX_DISCOVERY_DEPTH || candidates.len() >= MAX_DISCOVERED_ASSETS {
        return Ok(());
    }
    let entries = fs::read_dir(directory).map_err(|err| {
        AppError::Operation(format!(
            "failed to read project asset directory {}: {err}",
            directory.display()
        ))
    })?;

    for entry in entries {
        if candidates.len() >= MAX_DISCOVERED_ASSETS {
            break;
        }
        let entry = entry.map_err(|err| {
            AppError::Operation(format!(
                "failed to read project asset entry in {}: {err}",
                directory.display()
            ))
        })?;
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type().map_err(|err| {
            AppError::Operation(format!(
                "failed to read project asset entry type {}: {err}",
                entry.path().display()
            ))
        })?;
        let path = entry.path();
        if file_type.is_dir() {
            scan_asset_directory(project_id, &path, depth + 1, seen_paths, candidates, now)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let Some(kind) = asset_kind_for_file(&path) else {
            continue;
        };
        let path_text = path.to_string_lossy().into_owned();
        if !seen_paths.insert(path_text.clone()) {
            continue;
        }
        let content = if matches!(kind.as_str(), "note" | "protocol") {
            match read_text_asset_content(&path) {
                Ok(content) => Some(content),
                Err(_) => continue,
            }
        } else {
            None
        };
        candidates.push(ProjectAsset {
            id: stable_asset_id(project_id, &path_text),
            project_id: project_id.to_owned(),
            kind,
            title: title_for_path(&path),
            path: Some(path_text),
            content,
            description: String::new(),
            created_at: now,
            updated_at: now,
        });
    }
    Ok(())
}

fn refresh_project_asset_catalog(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> Result<ProjectAssetCatalog, AppError> {
    let project = writes::load_project(conn, project_id)
        .map_err(AppError::Operation)?
        .ok_or_else(|| AppError::NotFound(format!("project {project_id} not found")))?;
    let existing_assets =
        writes::list_project_assets(conn, project_id).map_err(AppError::Operation)?;
    let candidates = discover_project_asset_candidates(&project, &existing_assets)?;
    let imported_count = candidates.len();

    for mut asset in candidates {
        hydrate_text_asset_content(&mut asset)?;
        writes::save_project_asset(conn, &asset).map_err(AppError::Operation)?;
    }

    Ok(ProjectAssetCatalog {
        assets: writes::list_project_assets(conn, project_id).map_err(AppError::Operation)?,
        attachments: writes::list_asset_attachments(conn, Some(project_id))
            .map_err(AppError::Operation)?,
        imported_count,
        scanned_roots: project_asset_scanned_roots(&project),
        inventory: project_inventory_entries(&project)?,
    })
}

fn unix_millis_i64() -> i64 {
    i64::try_from(unix_millis()).unwrap_or(i64::MAX)
}

/// Write a short executable wrapper for Codex launches. The PTY only receives
/// `zsh /path/to/script`, which avoids zsh quote-continuation failures when the
/// full MCP config and bootstrap prompt are long.
#[tauri::command]
pub fn ui_write_codex_launch_script(
    instance_id: String,
    command: String,
) -> Result<String, AppError> {
    let id = instance_id.trim();
    if id.is_empty() {
        return Err(AppError::Validation("instance_id is required".into()));
    }
    let launch_command = command.trim();
    if launch_command.is_empty() {
        return Err(AppError::Validation("command is required".into()));
    }
    if launch_command.contains('\0') {
        return Err(AppError::Validation(
            "command contains invalid null byte".into(),
        ));
    }

    let root = codex_launch_script_root()?;
    fs::create_dir_all(&root).map_err(|err| {
        AppError::Operation(format!(
            "failed to create Codex launch script directory: {err}"
        ))
    })?;
    let script_path = root.join(format!("codex-{}.zsh", sanitize_script_name(id)));
    let interactive_command = format!("exec {launch_command}");
    let body = format!(
        "#!/bin/zsh\nset -e\n# Generated by swarm-ui. Launches Codex with swarm MCP config and bootstrap prompt.\nexec /bin/zsh -lic {}\n",
        shell_single_quote(&interactive_command),
    );
    fs::write(&script_path, body).map_err(|err| {
        AppError::Operation(format!("failed to write Codex launch script: {err}"))
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&script_path)
            .map_err(|err| {
                AppError::Operation(format!("failed to inspect Codex launch script: {err}"))
            })?
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&script_path, permissions).map_err(|err| {
            AppError::Operation(format!(
                "failed to mark Codex launch script executable: {err}"
            ))
        })?;
    }

    Ok(script_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn ui_resolve_swarm_mcp_server(
    cwd: String,
    scope: Option<String>,
) -> Result<SwarmMcpServerConfig, AppError> {
    if let Some(config) =
        scope_path(scope).and_then(|path| dist_index_candidate(path, "scope-dist"))
    {
        return Ok(config);
    }

    let cwd = trim_required(&cwd, "cwd")?;
    if let Some(config) = dist_index_candidate(PathBuf::from(cwd), "cwd-dist") {
        return Ok(config);
    }

    if let Ok(current_dir) = std::env::current_dir() {
        if let Some(config) = dist_index_candidate(current_dir, "process-dist") {
            return Ok(config);
        }
    }

    if let Some(config) = manifest_dist_index_candidate() {
        return Ok(config);
    }

    if let Some(config) = installed_swarm_mcp_binary() {
        return Ok(config);
    }

    Err(AppError::Operation(
        "could not resolve a built swarm MCP server. Run `bun run build` in the swarm-mcp repo or install `swarm-mcp` on PATH.".into(),
    ))
}

/// Overwrite an instance's `label` column. The frontend composes the new
/// label string (preserving existing tokens like `name:`, `role:`, etc) and
/// sends the whole thing back. Used by the persona picker — when the user
/// changes an agent's emoji, the UI rewrites the `persona:` token in the
/// label and calls this to persist it.
///
/// No scope check: the user explicitly clicked an agent's persona tab, so
/// the choice of agent is theirs. Empty `label` is allowed (clears all
/// tokens). Returns `true` if the row existed and was updated.
#[tauri::command]
pub fn ui_set_instance_label(instance_id: String, label: String) -> Result<bool, AppError> {
    let id = instance_id.trim();
    if id.is_empty() {
        return Err(AppError::Validation("instance_id is required".into()));
    }
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::update_instance_label(&conn, id, &label).map_err(AppError::Operation)
}

/// Clear all message history between two instances in either direction.
/// Triggered by the Inspector's "Clear messages" button on a selected
/// ConnectionEdge. Both ids must be non-empty; no scope check — the UI
/// shows any pair in the current snapshot so the user decides.
#[tauri::command]
pub fn ui_clear_messages(instance_a: String, instance_b: String) -> Result<usize, AppError> {
    let a = instance_a.trim();
    let b = instance_b.trim();
    if a.is_empty() || b.is_empty() {
        return Err(AppError::Validation(
            "both instance ids are required".into(),
        ));
    }
    if a == b {
        return Err(AppError::Validation(
            "cannot clear messages with the same instance on both sides".into(),
        ));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::clear_messages_between(&conn, a, b).map_err(AppError::Operation)
}

/// Unassign a task. Called from the Inspector's per-task delete button on
/// a selected ConnectionEdge. Resets claimed/in-progress back to open so
/// another agent can pick it up.
#[tauri::command]
pub fn ui_unassign_task(task_id: String) -> Result<bool, AppError> {
    let id = task_id.trim();
    if id.is_empty() {
        return Err(AppError::Validation("task_id is required".into()));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::unassign_task(&conn, id).map_err(AppError::Operation)
}

/// Remove one entry from a task's `depends_on` array. Called from the
/// Inspector's per-dependency delete button.
#[tauri::command]
pub fn ui_remove_dependency(
    dependent_task_id: String,
    dependency_task_id: String,
) -> Result<bool, AppError> {
    let dependent = dependent_task_id.trim();
    let dependency = dependency_task_id.trim();
    if dependent.is_empty() || dependency.is_empty() {
        return Err(AppError::Validation("both task ids are required".into()));
    }
    if dependent == dependency {
        return Err(AppError::Validation(
            "a task cannot depend on itself".into(),
        ));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::remove_task_dependency(&conn, dependent, dependency).map_err(AppError::Operation)
}

/// Remove an instance row and everything keyed to it (locks, queued
/// messages, task assignments released). Used when the user clicks the
/// remove button on a disconnected node whose PTY is already gone — e.g.,
/// an orphan row left over from a previous UI session, or a child process
/// the user killed outside the UI.
///
/// No scope check: the UI can see any instance in the snapshot, so the
/// user gets to decide what to clean up. The binder mapping is dropped
/// too so the node doesn't keep rendering as `bound:` against a
/// deleted instance id.
#[tauri::command]
pub fn ui_deregister_instance(
    binder: State<'_, Binder>,
    instance_id: String,
) -> Result<(), AppError> {
    let trimmed = instance_id.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("instance_id is required".into()));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    let instance = writes::load_instance_info(&conn, trimmed)
        .map_err(AppError::Operation)?
        .ok_or_else(|| AppError::NotFound(format!("instance {trimmed} not found")))?;

    if binder.resolved_pty_for(trimmed).is_some() {
        return Err(AppError::Validation(format!(
            "instance {trimmed} still has a live PTY in this session"
        )));
    }

    let status = instance_status_from_heartbeat(instance.heartbeat);
    if !matches!(status, InstanceStatus::Stale | InstanceStatus::Offline) {
        return Err(AppError::Validation(format!(
            "instance {trimmed} is {} and cannot be removed yet",
            instance_status_label(status)
        )));
    }

    writes::deregister_instance(&conn, trimmed).map_err(AppError::Operation)?;

    binder.unbind(trimmed);
    Ok(())
}

/// Force-remove an instance row that the user has explicitly asked to nuke
/// from the Home screen, bypassing the gentle policy checks in
/// `ui_deregister_instance`. Needed because the UI surfaces prev-session rows
/// whose heartbeat is still fresh (server-side heartbeating, pre-stale
/// window) or whose binder resolution points at a PTY the daemon has
/// already forgotten about. In both cases the gentle path deadlocks and
/// the × button appears to do nothing.
///
/// Semantics:
///   - If the binder still has a resolution for this id, best-effort close
///     the underlying PTY on the daemon. A failure here (PTY already dead,
///     daemon doesn't know it) is ignored — the user's intent is unambiguous.
///   - Unconditionally drop the binder mapping.
///   - Deregister the row via `writes::deregister_instance`, which cascades
///     task/lock/message cleanup the same way the gentle path does.
///
/// The frontend gates every call to this with a confirm dialog, so the
/// "force" behavior is user-initiated rather than policy-bypassing by
/// default.
#[tauri::command]
pub async fn ui_force_deregister_instance(
    binder: State<'_, Binder>,
    instance_id: String,
) -> Result<(), AppError> {
    let trimmed = instance_id.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("instance_id is required".into()));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::load_instance_info(&conn, trimmed)
        .map_err(AppError::Operation)?
        .ok_or_else(|| AppError::NotFound(format!("instance {trimmed} not found")))?;

    // Best-effort PTY close when the binder has a resolution. Errors from the
    // daemon (unknown PTY, already closed) are swallowed because the user has
    // explicitly asked to tear this row down and any lingering PTY mapping
    // must not block the row deletion.
    if let Some(pty_id) = binder.resolved_pty_for(trimmed) {
        let _ = daemon::close_pty(&pty_id, true).await;
    }

    writes::deregister_instance(&conn, trimmed).map_err(AppError::Operation)?;
    binder.unbind(trimmed);
    Ok(())
}

/// Bulk-delete every instance row whose heartbeat has aged past the "stale"
/// threshold, optionally restricted to one scope. Lets the user one-click
/// clean up a pile of adopting-but-dead nodes instead of trashing each row
/// individually. Live PTYs still bound to an instance are skipped so the
/// user doesn't lose a node they can still interact with.
#[tauri::command]
pub fn ui_deregister_offline_instances(
    binder: State<'_, Binder>,
    scope: Option<String>,
) -> Result<usize, AppError> {
    let scope_filter = scope
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or_default();
    let stale_cutoff = now.saturating_sub(crate::model::INSTANCE_STALE_AFTER_SECS);

    let mut stmt = conn
        .prepare("SELECT id, scope FROM instances WHERE heartbeat < ?")
        .map_err(|err| AppError::Operation(format!("failed to query offline instances: {err}")))?;
    let rows: Vec<(String, String)> = stmt
        .query_map([stale_cutoff], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| {
            AppError::Operation(format!("failed to enumerate offline instances: {err}"))
        })?
        .collect::<Result<_, _>>()
        .map_err(|err| {
            AppError::Operation(format!("failed to read offline instance row: {err}"))
        })?;
    drop(stmt);

    let mut removed = 0usize;
    for (id, row_scope) in rows {
        if let Some(target) = scope_filter {
            if row_scope != target {
                continue;
            }
        }
        if binder.resolved_pty_for(&id).is_some() {
            continue;
        }
        writes::deregister_instance(&conn, &id).map_err(AppError::Operation)?;
        binder.unbind(&id);
        removed += 1;
    }

    Ok(removed)
}

/// Remove stale unadopted placeholder rows that no longer have any live PTY
/// attached. This is the narrow orphan cleanup path used by the Home and
/// Settings diagnostics so recovery cleanup does not touch adopted sessions.
#[tauri::command]
pub fn ui_sweep_unadopted_orphans() -> Result<usize, AppError> {
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::sweep_unadopted_orphans(&conn).map_err(AppError::Operation)
}

/// Persist the graph layout for one swarm scope under the shared `ui/layout`
/// KV entry. The frontend calls this after local drag/reflow changes so
/// layout becomes durable and can also be driven by the CLI worker.
#[tauri::command]
pub fn ui_set_layout(scope: String, layout: SavedLayout) -> Result<(), AppError> {
    let trimmed = scope.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("scope is required".into()));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::save_ui_layout(&conn, trimmed, &layout).map_err(AppError::Operation)
}

/// Export the saved graph layout for one scope to a JSON artifact. This is the
/// direct Settings-path twin of the CLI `ui export-layout` queued command.
#[tauri::command]
pub fn ui_export_layout(scope: String, out: Option<String>) -> Result<Value, AppError> {
    let trimmed = scope.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("scope is required".into()));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    let layout = writes::load_ui_layout(&conn, trimmed).map_err(AppError::Operation)?;
    let path = resolve_artifact_path(out.as_deref(), "swarm-ui-layout", "json")
        .map_err(AppError::Operation)?;
    let node_count = layout.nodes.len();
    let body = json!({
        "version": 1,
        "exportedAtUnixMs": unix_millis(),
        "scope": trimmed,
        "layout": layout,
    });
    write_json_artifact(&path, &body).map_err(AppError::Operation)?;
    Ok(json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "scope": trimmed,
        "node_count": node_count,
    }))
}

/// Explicit screenshot command placeholder. Tauri does not expose a safe,
/// portable transparent-window screenshot path in the current runtime, so this
/// command returns a visible unsupported result instead of pretending success.
#[tauri::command]
pub fn ui_capture_screenshot(out: Option<String>) -> Result<Value, AppError> {
    let _requested_path = out;
    Ok(json!({
        "ok": false,
        "error": "window screenshot capture unavailable in this runtime",
    }))
}

/// Persist a frontend-built proof pack artifact. The frontend owns the
/// semantic snapshot because it can read DOM bounds, text, scroll containers,
/// and theme variables directly.
#[tauri::command]
pub fn ui_write_proof_pack(pack: Value, out: Option<String>) -> Result<Value, AppError> {
    let path = resolve_artifact_path(out.as_deref(), "swarm-ui-proof-pack", "json")
        .map_err(AppError::Operation)?;
    let mut body = pack;
    match &mut body {
        Value::Object(object) => {
            object.insert(
                "artifact".to_owned(),
                json!({
                    "kind": "swarm-ui-proof-pack-artifact",
                    "writtenAtUnixMs": unix_millis(),
                    "path": path.to_string_lossy(),
                }),
            );
        }
        _ => {
            body = json!({
                "version": 1,
                "kind": "swarm-ui-proof-pack",
                "generatedAtUnixMs": unix_millis(),
                "artifact": {
                    "kind": "swarm-ui-proof-pack-artifact",
                    "writtenAtUnixMs": unix_millis(),
                    "path": path.to_string_lossy(),
                },
                "pack": body,
            });
        }
    }
    write_json_artifact(&path, &body).map_err(AppError::Operation)?;
    let byte_count = fs::metadata(&path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    Ok(json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "byte_count": byte_count,
    }))
}

#[tauri::command]
pub fn ui_launch_chrome() -> Result<ChromeLaunchResult, AppError> {
    let status = Command::new("/usr/bin/open")
        .arg("-a")
        .arg("Google Chrome")
        .status()
        .map_err(|err| AppError::Operation(format!("failed to launch Google Chrome: {err}")))?;

    if !status.success() {
        return Err(AppError::Operation(format!(
            "Google Chrome launch exited with status {status}"
        )));
    }

    Ok(ChromeLaunchResult {
        ok: true,
        app: "Google Chrome".into(),
        note:
            "Chrome is open. Agent-readable import stays explicit through the browser bridge phase."
                .into(),
    })
}

#[tauri::command]
pub fn ui_launch_native_app(app_id: String) -> Result<NativeAppLaunchResult, AppError> {
    let app_id = trim_required(&app_id, "app_id")?.to_ascii_lowercase();
    let app = native_app_name(&app_id)?;
    let status = Command::new("open")
        .arg("-a")
        .arg(app)
        .status()
        .map_err(|err| AppError::Operation(format!("failed to launch {app}: {err}")))?;

    if !status.success() {
        return Err(AppError::Operation(format!(
            "{app} launch exited with status {status}"
        )));
    }

    Ok(NativeAppLaunchResult {
        ok: true,
        app_id,
        app: app.into(),
        note: format!("{app} is open and represented as a canvas app surface."),
    })
}

#[tauri::command]
pub fn ui_list_browser_catalog(scope: String) -> Result<BrowserCatalog, AppError> {
    let scope = trim_required(&scope, "scope")?;
    browser_catalog(&scope)
}

#[tauri::command]
pub fn ui_refresh_browser_catalog(scope: String) -> Result<BrowserCatalog, AppError> {
    let scope = trim_required(&scope, "scope")?;
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    let contexts = writes::list_browser_contexts(&conn, &scope).map_err(AppError::Operation)?;
    drop(conn);

    for context in &contexts {
        refresh_browser_context_for_catalog(context)?;
    }

    browser_catalog(&scope)
}

#[tauri::command]
pub fn ui_refresh_browser_context(
    scope: String,
    context_id: String,
) -> Result<BrowserCatalog, AppError> {
    let scope = trim_required(&scope, "scope")?;
    let context_id = trim_required(&context_id, "context_id")?;
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    let context = writes::load_browser_context(&conn, &scope, &context_id)
        .map_err(AppError::Operation)?
        .ok_or_else(|| AppError::Operation(format!("browser context {context_id} not found")))?;
    drop(conn);

    if let Err(err) = refresh_browser_context_for_catalog(&context) {
        eprintln!(
            "[browser] initial tab refresh failed for managed context {}: {err}",
            context.id
        );
    }
    browser_catalog(&scope)
}

#[tauri::command]
pub async fn ui_capture_browser_snapshot(
    scope: String,
    context_id: String,
    tab_id: Option<String>,
) -> Result<BrowserCatalog, AppError> {
    let scope = trim_required(&scope, "scope")?;
    let context_id = trim_required(&context_id, "context_id")?;
    let tab_id = normalize_optional(tab_id);
    let context = {
        let conn = writes::open_rw().map_err(AppError::Operation)?;
        writes::load_browser_context(&conn, &scope, &context_id)
            .map_err(AppError::Operation)?
            .ok_or_else(|| AppError::Operation(format!("browser context {context_id} not found")))?
    };

    let snapshot = capture_browser_snapshot(&context, tab_id).await?;
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::record_browser_snapshot(&conn, &snapshot).map_err(AppError::Operation)?;
    drop(conn);
    browser_catalog(&scope)
}

fn open_browser_context_for_scope(
    scope: &str,
    start_url: String,
    extra_urls: Vec<String>,
    headless: bool,
) -> Result<BrowserCatalog, AppError> {
    let id = format!("ui-{}", Uuid::new_v4());
    let port = allocate_browser_port()?;
    let profile_dir = browser_context_root()?.join(&id);
    fs::create_dir_all(&profile_dir).map_err(|err| {
        AppError::Operation(format!(
            "failed to create browser profile {}: {err}",
            profile_dir.display()
        ))
    })?;

    let mut command = Command::new(DEFAULT_CHROME_PATH);
    command
        .arg(format!("--remote-debugging-port={port}"))
        .arg(format!("--user-data-dir={}", profile_dir.display()))
        .arg("--remote-allow-origins=*")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-popup-blocking")
        .arg("--new-window");
    if headless {
        command.arg("--headless=new").arg("--disable-gpu");
    }
    command.arg(&start_url);
    for url in &extra_urls {
        command.arg(url);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| AppError::Operation(format!("failed to launch managed Chrome: {err}")))?;

    if let Err(err) = wait_for_cdp(port) {
        let _ = child.kill();
        return Err(err);
    }

    let now = unix_millis_i64() / 1000;
    let context = BrowserContext {
        scope: scope.to_owned(),
        id,
        owner_instance_id: None,
        endpoint: format!("http://{DEFAULT_BROWSER_HOST}:{port}"),
        host: DEFAULT_BROWSER_HOST.into(),
        port: i64::from(port),
        profile_dir: profile_dir.to_string_lossy().into_owned(),
        pid: Some(i64::from(child.id())),
        start_url,
        status: "open".into(),
        created_at: now,
        updated_at: now,
    };

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::save_browser_context(&conn, &context).map_err(AppError::Operation)?;
    drop(conn);
    refresh_browser_context_for_catalog(&context)?;
    drop(child);
    browser_catalog(&scope)
}

#[tauri::command]
pub fn ui_open_browser_context(
    scope: String,
    url: Option<String>,
    headless: Option<bool>,
) -> Result<BrowserCatalog, AppError> {
    let scope = trim_required(&scope, "scope")?;
    let start_url = normalize_browser_url(url);
    open_browser_context_for_scope(&scope, start_url, Vec::new(), headless.unwrap_or(false))
}

#[tauri::command]
pub fn ui_import_front_chrome_tab(scope: String) -> Result<BrowserCatalog, AppError> {
    let scope = trim_required(&scope, "scope")?;
    let tab = front_chrome_tab()?;
    open_browser_context_for_scope(&scope, tab.url, Vec::new(), true)
}

#[tauri::command]
pub fn ui_list_chrome_tabs() -> Result<Vec<ChromeTabCandidate>, AppError> {
    chrome_tabs()
}

#[tauri::command]
pub fn ui_import_chrome_tabs(
    scope: String,
    tabs: Vec<ChromeTabCandidate>,
    headless: Option<bool>,
) -> Result<BrowserCatalog, AppError> {
    let scope = trim_required(&scope, "scope")?;
    let mut urls = tabs
        .into_iter()
        .map(|tab| normalize_browser_url(Some(tab.url)))
        .filter(|url| !url.trim().is_empty())
        .collect::<Vec<_>>();
    if urls.is_empty() {
        return Err(AppError::Validation(
            "select at least one Chrome tab to import".into(),
        ));
    }
    let start_url = urls.remove(0);
    open_browser_context_for_scope(&scope, start_url, urls, headless.unwrap_or(false))
}

#[tauri::command]
pub fn ui_close_browser_context(
    scope: String,
    context_id: String,
) -> Result<BrowserCatalog, AppError> {
    let scope = trim_required(&scope, "scope")?;
    let context_id = trim_required(&context_id, "context_id")?;
    let context = {
        let conn = writes::open_rw().map_err(AppError::Operation)?;
        writes::load_browser_context(&conn, &scope, &context_id)
            .map_err(AppError::Operation)?
            .ok_or_else(|| AppError::Operation(format!("browser context {context_id} not found")))?
    };

    if let Some(pid) = context.pid {
        terminate_browser_pid(pid)?;
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::close_browser_context(&conn, &scope, &context_id, unix_millis_i64() / 1000)
        .map_err(AppError::Operation)?;
    browser_catalog(&scope)
}

#[tauri::command]
pub fn ui_delete_browser_context(
    scope: String,
    context_id: String,
) -> Result<BrowserCatalog, AppError> {
    let scope = trim_required(&scope, "scope")?;
    let context_id = trim_required(&context_id, "context_id")?;
    let context = {
        let conn = writes::open_rw().map_err(AppError::Operation)?;
        writes::load_browser_context(&conn, &scope, &context_id)
            .map_err(AppError::Operation)?
            .ok_or_else(|| AppError::Operation(format!("browser context {context_id} not found")))?
    };

    if let Some(pid) = context.pid {
        terminate_browser_pid(pid)?;
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::delete_browser_context(&conn, &scope, &context_id).map_err(AppError::Operation)?;
    drop(conn);
    remove_browser_profile_dir(&context.profile_dir)?;
    browser_catalog(&scope)
}

#[tauri::command]
pub fn ui_list_projects() -> Result<ProjectCatalog, AppError> {
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    Ok(ProjectCatalog {
        projects: writes::list_projects(&conn).map_err(AppError::Operation)?,
        memberships: writes::list_project_memberships(&conn).map_err(AppError::Operation)?,
    })
}

#[tauri::command]
pub fn ui_default_project_root() -> Result<String, AppError> {
    dirs::desktop_dir()
        .or_else(dirs::home_dir)
        .map(|path| path.to_string_lossy().into_owned())
        .ok_or_else(|| AppError::Operation("failed to resolve Desktop or home directory".into()))
}

#[tauri::command]
pub fn ui_ensure_project_folder(root: String) -> Result<String, AppError> {
    let path = resolve_project_root_path(&root)?;
    fs::create_dir_all(&path).map_err(|err| {
        AppError::Operation(format!(
            "failed to create project folder {}: {err}",
            path.display()
        ))
    })?;
    if !path.is_dir() {
        return Err(AppError::Operation(format!(
            "project path is not a directory: {}",
            path.display()
        )));
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn ui_save_project(project: ProjectSpace) -> Result<ProjectSpace, AppError> {
    let normalized = normalize_project_payload(project)?;
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::save_project(&conn, &normalized).map_err(AppError::Operation)
}

#[tauri::command]
pub fn ui_delete_project(project_id: String) -> Result<bool, AppError> {
    let id = trim_required(&project_id, "project id")?;
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::delete_project(&conn, &id).map_err(AppError::Operation)
}

#[tauri::command]
pub fn ui_attach_instance_to_project(
    project_id: String,
    instance_id: String,
) -> Result<ProjectMembership, AppError> {
    let project_id = trim_required(&project_id, "project id")?;
    let instance_id = trim_required(&instance_id, "instance id")?;
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::attach_instance_to_project(&conn, &project_id, &instance_id, unix_millis_i64())
        .map_err(AppError::Operation)
}

#[tauri::command]
pub fn ui_detach_instance_from_project(
    project_id: String,
    instance_id: String,
) -> Result<bool, AppError> {
    let project_id = trim_required(&project_id, "project id")?;
    let instance_id = trim_required(&instance_id, "instance id")?;
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::detach_instance_from_project(&conn, &project_id, &instance_id)
        .map_err(AppError::Operation)
}

#[tauri::command]
pub fn ui_list_project_assets(project_id: String) -> Result<ProjectAssetCatalog, AppError> {
    let project_id = trim_required(&project_id, "project id")?;
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    let project = writes::load_project(&conn, &project_id)
        .map_err(AppError::Operation)?
        .ok_or_else(|| AppError::NotFound(format!("project {project_id} not found")))?;
    Ok(ProjectAssetCatalog {
        assets: writes::list_project_assets(&conn, &project_id).map_err(AppError::Operation)?,
        attachments: writes::list_asset_attachments(&conn, Some(&project_id))
            .map_err(AppError::Operation)?,
        imported_count: 0,
        scanned_roots: project_asset_scanned_roots(&project),
        inventory: project_inventory_entries(&project)?,
    })
}

#[tauri::command]
pub fn ui_save_project_asset(asset: ProjectAsset) -> Result<ProjectAsset, AppError> {
    let mut normalized = normalize_asset_payload(asset)?;
    hydrate_text_asset_content(&mut normalized)?;
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::save_project_asset(&conn, &normalized).map_err(AppError::Operation)
}

#[tauri::command]
pub fn ui_create_project_note_asset(
    project_id: String,
    title: String,
    content: Option<String>,
) -> Result<ProjectAsset, AppError> {
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    write_project_note_asset_record(&conn, &project_id, &title, content)
}

#[tauri::command]
pub fn ui_update_project_note_asset_content(
    asset_id: String,
    content: String,
) -> Result<ProjectAsset, AppError> {
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    write_project_text_asset_content(&conn, &asset_id, &content)
}

#[tauri::command]
pub fn ui_open_project_asset_path(asset_id: String) -> Result<bool, AppError> {
    let id = trim_required(&asset_id, "asset id")?;
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    let asset = writes::load_project_asset(&conn, &id)
        .map_err(AppError::Operation)?
        .ok_or_else(|| AppError::NotFound(format!("asset {id} not found")))?;
    let path = asset
        .path
        .as_deref()
        .ok_or_else(|| AppError::Validation("asset has no file path to open".into()))?;
    let path_buf = validate_local_asset_path(path, "asset path")?;
    if !path_buf.exists() {
        return Err(AppError::Validation(format!(
            "asset path does not exist: {}",
            path_buf.display()
        )));
    }
    let status = Command::new("/usr/bin/open")
        .arg(&path_buf)
        .status()
        .map_err(|err| {
            AppError::Operation(format!(
                "failed to open asset path {}: {err}",
                path_buf.display()
            ))
        })?;
    if !status.success() {
        return Err(AppError::Operation(format!(
            "open exited with status {status} for {}",
            path_buf.display()
        )));
    }
    Ok(true)
}

#[tauri::command]
pub fn ui_analyze_project_asset(asset_id: String) -> Result<ProjectAsset, AppError> {
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    analyze_project_asset_with_runner(&conn, &asset_id, run_visual_analysis)
}

#[tauri::command]
pub fn ui_get_asset_analyzer_settings() -> AssetAnalyzerSettings {
    asset_analyzer_settings_from_config(load_asset_analyzer_config())
}

#[tauri::command]
pub fn ui_save_asset_analyzer_settings(
    settings: AssetAnalyzerSettingsInput,
) -> Result<AssetAnalyzerSettings, AppError> {
    let mut config = load_asset_analyzer_config();
    config.openai_model = non_empty(settings.openai_model);
    config.custom_command = non_empty(settings.custom_command);
    save_asset_analyzer_config(&config)?;

    if settings.clear_openai_api_key {
        delete_keychain_openai_api_key()?;
    }

    if let Some(api_key) = settings
        .openai_api_key
        .as_deref()
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        write_keychain_openai_api_key(api_key)?;
    }

    Ok(asset_analyzer_settings_from_config(config))
}

#[tauri::command]
pub fn ui_read_asset_text_file(path: String) -> Result<String, AppError> {
    let path_buf = validate_text_asset_path(&path)?;
    read_text_asset_content(&path_buf)
}

#[tauri::command]
pub fn ui_refresh_project_assets(project_id: String) -> Result<ProjectAssetCatalog, AppError> {
    let project_id = trim_required(&project_id, "project id")?;
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    refresh_project_asset_catalog(&conn, &project_id)
}

#[tauri::command]
pub fn ui_delete_project_asset(asset_id: String) -> Result<bool, AppError> {
    let id = trim_required(&asset_id, "asset id")?;
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::delete_project_asset(&conn, &id).map_err(AppError::Operation)
}

#[tauri::command]
pub fn ui_attach_asset(
    asset_id: String,
    target_type: String,
    target_id: String,
) -> Result<AssetAttachment, AppError> {
    let asset_id = trim_required(&asset_id, "asset id")?;
    let target_type = trim_required(&target_type, "target type")?;
    if !ASSET_TARGET_TYPES.contains(&target_type.as_str()) {
        return Err(AppError::Validation(format!(
            "unsupported asset target type: {target_type}"
        )));
    }
    let target_id = trim_required(&target_id, "target id")?;
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::attach_asset(
        &conn,
        &asset_id,
        &target_type,
        &target_id,
        unix_millis_i64(),
    )
    .map_err(AppError::Operation)
}

#[tauri::command]
pub fn ui_detach_asset(
    asset_id: String,
    target_type: String,
    target_id: String,
) -> Result<bool, AppError> {
    let asset_id = trim_required(&asset_id, "asset id")?;
    let target_type = trim_required(&target_type, "target type")?;
    if !ASSET_TARGET_TYPES.contains(&target_type.as_str()) {
        return Err(AppError::Validation(format!(
            "unsupported asset target type: {target_type}"
        )));
    }
    let target_id = trim_required(&target_id, "target id")?;
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::detach_asset(&conn, &asset_id, &target_type, &target_id).map_err(AppError::Operation)
}

fn unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn resolve_artifact_path(
    requested: Option<&str>,
    stem: &str,
    extension: &str,
) -> Result<PathBuf, String> {
    if let Some(raw) = requested.map(str::trim).filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(raw));
    }

    let base = dirs::home_dir()
        .ok_or_else(|| "failed to resolve home directory for artifacts".to_owned())?
        .join(".swarm-mcp")
        .join("artifacts");
    Ok(base.join(format!("{stem}-{}.{}", unix_millis(), extension)))
}

fn write_json_artifact(path: &PathBuf, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "failed to create artifact directory {}: {err}",
                parent.display()
            )
        })?;
    }
    let raw = serde_json::to_string_pretty(value)
        .map_err(|err| format!("failed to serialize artifact: {err}"))?;
    fs::write(path, raw)
        .map_err(|err| format!("failed to write artifact {}: {err}", path.display()))
}

fn safe_capture_segment(value: &str, field: &str) -> Result<String, AppError> {
    let sanitized = sanitize_filename_component(value);
    if sanitized.is_empty() {
        return Err(AppError::Validation(format!("{field} is required")));
    }
    Ok(sanitized)
}

fn area_capture_session_root(
    root: &Path,
    date_key: &str,
    session_id: &str,
) -> Result<PathBuf, AppError> {
    let date = safe_capture_segment(date_key, "date_key")?;
    let session = safe_capture_segment(session_id, "session_id")?;
    Ok(root
        .join("area-captures")
        .join(date)
        .join(format!("session-{session}")))
}

fn decode_png_data_url(png_data_url: &str) -> Result<Vec<u8>, AppError> {
    let trimmed = png_data_url.trim();
    let encoded = trimmed
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| AppError::Validation("png_data_url must be a PNG data URL".into()))?;
    let compact: String = encoded.chars().filter(|ch| !ch.is_whitespace()).collect();
    general_purpose::STANDARD
        .decode(compact)
        .map_err(|err| AppError::Validation(format!("png_data_url is not valid base64: {err}")))
}

fn write_area_capture_files(
    root: &Path,
    date_key: &str,
    session_id: &str,
    base_name: &str,
    png_data_url: &str,
    metadata: Value,
) -> Result<AreaCaptureSaveResult, AppError> {
    let dir = area_capture_session_root(root, date_key, session_id)?;
    fs::create_dir_all(&dir).map_err(|err| {
        AppError::Operation(format!(
            "failed to create area capture directory {}: {err}",
            dir.display()
        ))
    })?;

    let base = safe_capture_segment(base_name, "base_name")?;
    let png_name = format!("{base}.png");
    let markdown_name = format!("{base}.md");
    let json_name = format!("{base}.json");
    let png_path = dir.join(&png_name);
    let markdown_path = dir.join(&markdown_name);
    let json_path = dir.join(&json_name);
    let proof_level = metadata
        .get("proofLevel")
        .and_then(Value::as_str)
        .unwrap_or("app-region-dom")
        .to_owned();

    fs::write(&png_path, decode_png_data_url(png_data_url)?).map_err(|err| {
        AppError::Operation(format!(
            "failed to write area capture PNG {}: {err}",
            png_path.display()
        ))
    })?;
    let metadata_raw = serde_json::to_string_pretty(&metadata)
        .map_err(|err| AppError::Internal(format!("failed to encode area metadata: {err}")))?;
    fs::write(&json_path, format!("{metadata_raw}\n")).map_err(|err| {
        AppError::Operation(format!(
            "failed to write area capture JSON {}: {err}",
            json_path.display()
        ))
    })?;

    let markdown = format!(
        "# Area Capture {base}\n\n![capture]({png_name})\n\n- Proof level: {proof_level}\n- Metadata: {json_name}\n\n## Metadata\n\n```json\n{metadata_raw}\n```\n"
    );
    fs::write(&markdown_path, markdown).map_err(|err| {
        AppError::Operation(format!(
            "failed to write area capture markdown {}: {err}",
            markdown_path.display()
        ))
    })?;

    Ok(AreaCaptureSaveResult {
        ok: true,
        root: dir.to_string_lossy().into_owned(),
        png_path: png_path.to_string_lossy().into_owned(),
        markdown_path: markdown_path.to_string_lossy().into_owned(),
        json_path: json_path.to_string_lossy().into_owned(),
        proof_level,
    })
}

fn write_session_closeout_files(
    root: &Path,
    date_key: &str,
    session_id: &str,
    markdown: &str,
    packet: Value,
) -> Result<SessionCloseoutSaveResult, AppError> {
    let dir = area_capture_session_root(root, date_key, session_id)?;
    fs::create_dir_all(&dir).map_err(|err| {
        AppError::Operation(format!(
            "failed to create closeout directory {}: {err}",
            dir.display()
        ))
    })?;
    let markdown_path = dir.join("closeout-survey.md");
    let json_path = dir.join("closeout-survey.json");
    fs::write(&markdown_path, markdown).map_err(|err| {
        AppError::Operation(format!(
            "failed to write closeout markdown {}: {err}",
            markdown_path.display()
        ))
    })?;
    let raw = serde_json::to_string_pretty(&packet)
        .map_err(|err| AppError::Internal(format!("failed to encode closeout packet: {err}")))?;
    fs::write(&json_path, format!("{raw}\n")).map_err(|err| {
        AppError::Operation(format!(
            "failed to write closeout JSON {}: {err}",
            json_path.display()
        ))
    })?;
    Ok(SessionCloseoutSaveResult {
        ok: true,
        root: dir.to_string_lossy().into_owned(),
        markdown_path: markdown_path.to_string_lossy().into_owned(),
        json_path: json_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn ui_save_area_capture(
    date_key: String,
    session_id: String,
    base_name: String,
    png_data_url: String,
    metadata: Value,
) -> Result<AreaCaptureSaveResult, AppError> {
    write_area_capture_files(
        Path::new(LEARNING_EVOLUTION_ROOT),
        &date_key,
        &session_id,
        &base_name,
        &png_data_url,
        metadata,
    )
}

#[tauri::command]
pub fn ui_save_session_closeout(
    date_key: String,
    session_id: String,
    markdown: String,
    packet: Value,
) -> Result<SessionCloseoutSaveResult, AppError> {
    write_session_closeout_files(
        Path::new(LEARNING_EVOLUTION_ROOT),
        &date_key,
        &session_id,
        &markdown,
        packet,
    )
}

/// Exit the entire Tauri application process. Used by the UI's quit-confirm
/// dialog so app shutdown does not depend on platform-specific window-close
/// behavior (macOS keeps app lifetime separate from window lifetime).
#[tauri::command]
pub fn ui_exit_app<R: Runtime>(app_handle: AppHandle<R>) {
    app_handle.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_color_normalizes_to_safe_hex() {
        assert_eq!(normalize_project_color(" 35F2FF "), "#35f2ff");
        assert_eq!(normalize_project_color("#abc"), "#abc");
        assert_eq!(normalize_project_color("hotpink"), "#ffffff");
    }

    #[test]
    fn cdp_tabs_parse_with_first_page_active() {
        let tabs = parse_cdp_tabs(
            "scope-a",
            "ctx-a",
            r#"[
              {"id":"devtools","type":"other","url":"devtools://devtools","title":"DevTools"},
              {"id":"tab-1","type":"page","url":"https://example.com","title":"Example"}
            ]"#,
            123,
        )
        .unwrap();

        assert_eq!(tabs.len(), 2);
        assert!(!tabs[0].active);
        assert!(tabs[1].active);
        assert_eq!(tabs[1].scope, "scope-a");
        assert_eq!(tabs[1].context_id, "ctx-a");
        assert_eq!(tabs[1].tab_type, "page");
    }

    #[test]
    fn front_chrome_tab_output_parses_url_and_title() {
        let tab =
            parse_front_chrome_tab_output("https://example.com/path\nExample Title\n").unwrap();
        assert_eq!(tab.url, "https://example.com/path");
        assert_eq!(tab.title, "Example Title");
    }

    #[test]
    fn front_chrome_tab_output_rejects_missing_url() {
        let err = parse_front_chrome_tab_output("").unwrap_err();
        assert!(matches!(err, AppError::Operation(_)));
    }

    #[test]
    fn chrome_tabs_output_parses_multiple_rows() {
        let tabs = parse_chrome_tabs_output(
            "1\t1\t1\thttps://example.com\tExample\n1\t2\t0\thttps://openai.com\tOpenAI\n",
        );
        assert_eq!(tabs.len(), 2);
        assert_eq!(tabs[0].id, "w1:t1");
        assert!(tabs[0].active);
        assert_eq!(tabs[1].window_index, 1);
        assert_eq!(tabs[1].tab_index, 2);
        assert_eq!(tabs[1].title, "OpenAI");
    }

    #[test]
    fn browser_url_normalizes_common_inputs() {
        assert_eq!(normalize_browser_url(None), "about:blank");
        assert_eq!(
            normalize_browser_url(Some(" example.com ".into())),
            "https://example.com"
        );
        assert_eq!(
            normalize_browser_url(Some("localhost:1420".into())),
            "http://localhost:1420"
        );
        assert_eq!(
            normalize_browser_url(Some("http://127.0.0.1:1420".into())),
            "http://127.0.0.1:1420"
        );
        assert_eq!(
            normalize_browser_url(Some("about:blank".into())),
            "about:blank"
        );
    }

    #[test]
    fn launch_preflight_extracts_real_command_after_env_prefixes() {
        assert_eq!(
            extract_launch_executable("SWARM=1 exec flux9 --model gpt-5").unwrap(),
            "flux9"
        );
        assert_eq!(
            extract_launch_executable("env CODEX_HOME=/tmp codex --model gpt-5").unwrap(),
            "codex"
        );
    }

    #[test]
    fn launch_preflight_classifies_full_access_commands() {
        assert_eq!(command_trust_posture("flux9"), "full-access");
        assert_eq!(
            command_trust_posture("codex --dangerously-bypass-approvals-and-sandbox"),
            "full-access"
        );
        assert_eq!(command_trust_posture("codex"), "standard");
    }

    #[test]
    fn launch_preflight_resolves_path_command() {
        let result = ui_preflight_launch_command("sh -c true".into(), None).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(result.executable, "sh");
        assert!(result.resolved_path.is_some());
    }

    #[test]
    fn launch_preflight_blocks_missing_command() {
        let result =
            ui_preflight_launch_command("definitely-not-swarm-ui-command-xyz".into(), None)
                .unwrap();
        assert!(!result.ok);
        assert!(result.blocker.unwrap().contains("not found"));
    }

    #[test]
    fn swarm_mcp_manifest_root_falls_back_to_workspace_root() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let root = workspace_root_from_manifest_dir(manifest_dir).unwrap();

        assert_eq!(root.join("apps/swarm-ui/src-tauri"), manifest_dir);
    }

    #[test]
    fn snapshot_page_from_value_normalizes_elements() {
        let page = snapshot_page_from_value(json!({
            "url": "https://example.com",
            "title": "Example",
            "text": "Hello world",
            "elements": [
                {"tag": "button", "role": "button", "text": "Go", "selector": "#go"}
            ]
        }))
        .unwrap();

        assert_eq!(page.url, "https://example.com");
        assert_eq!(page.title, "Example");
        assert_eq!(page.elements.len(), 1);
        assert_eq!(page.elements[0].selector, "#go");
    }

    #[test]
    fn area_capture_rejects_non_png_data_url() {
        let err = decode_png_data_url("data:image/jpeg;base64,aGVsbG8=").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn area_capture_writes_png_markdown_and_json_sidecars() {
        let root = std::env::temp_dir().join(format!("swarm-ui-area-capture-{}", unix_millis()));
        let result = write_area_capture_files(
            &root,
            "2026-05-08",
            "session-a",
            "001-majordomo-button",
            "data:image/png;base64,aGVsbG8=",
            json!({
                "kind": "swarm-ui-area-capture",
                "proofLevel": "app-region-dom",
                "draft": { "surfaceId": "majordomo" }
            }),
        )
        .unwrap();

        assert!(PathBuf::from(&result.png_path).is_file());
        assert!(PathBuf::from(&result.markdown_path).is_file());
        assert!(PathBuf::from(&result.json_path).is_file());
        assert_eq!(result.proof_level, "app-region-dom");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn area_capture_closeout_writes_session_survey_sidecars() {
        let root = std::env::temp_dir().join(format!("swarm-ui-closeout-{}", unix_millis()));
        let result = write_session_closeout_files(
            &root,
            "2026-05-08",
            "session-a",
            "# Closeout\n",
            json!({ "sessionId": "session-a" }),
        )
        .unwrap();

        assert!(PathBuf::from(&result.markdown_path).is_file());
        assert!(PathBuf::from(&result.json_path).is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ensure_project_folder_creates_absolute_directory() {
        let path = std::env::temp_dir().join(format!("swarm-ui-project-{}", unix_millis()));
        let created = ui_ensure_project_folder(path.to_string_lossy().into_owned()).unwrap();
        assert!(PathBuf::from(&created).is_dir());
        let _ = fs::remove_dir_all(created);
    }

    #[test]
    fn ensure_project_folder_rejects_relative_paths() {
        let err = ui_ensure_project_folder("relative/project".into()).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn asset_payload_rejects_visual_asset_without_path() {
        let err = normalize_asset_payload(ProjectAsset {
            id: "asset-1".into(),
            project_id: "project-1".into(),
            kind: "image".into(),
            title: "Hero".into(),
            path: None,
            content: None,
            description: String::new(),
            created_at: 1,
            updated_at: 1,
        })
        .unwrap_err();

        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn asset_payload_rejects_unsupported_visual_extension() {
        let path = std::env::temp_dir().join(format!("swarm-ui-screenshot-{}.txt", unix_millis()));
        fs::write(&path, "not an image").unwrap();

        let err = normalize_asset_payload(ProjectAsset {
            id: "asset-1".into(),
            project_id: "project-1".into(),
            kind: "screenshot".into(),
            title: "Screenshot".into(),
            path: Some(path.to_string_lossy().into_owned()),
            content: None,
            description: String::new(),
            created_at: 1,
            updated_at: 1,
        })
        .unwrap_err();

        assert!(matches!(err, AppError::Validation(_)));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn asset_payload_rejects_missing_visual_path() {
        let path = std::env::temp_dir().join(format!("swarm-ui-missing-{}.png", unix_millis()));

        let err = normalize_asset_payload(ProjectAsset {
            id: "asset-1".into(),
            project_id: "project-1".into(),
            kind: "image".into(),
            title: "Hero".into(),
            path: Some(path.to_string_lossy().into_owned()),
            content: None,
            description: String::new(),
            created_at: 1,
            updated_at: 1,
        })
        .unwrap_err();

        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn asset_payload_accepts_note_content_without_path() {
        let asset = normalize_asset_payload(ProjectAsset {
            id: "asset-1".into(),
            project_id: "project-1".into(),
            kind: "note".into(),
            title: "Constraints".into(),
            path: None,
            content: Some("Keep context separate from sandboxing.".into()),
            description: String::new(),
            created_at: 1,
            updated_at: 1,
        })
        .unwrap();

        assert_eq!(asset.kind, "note");
    }

    #[test]
    fn asset_payload_rejects_text_asset_relative_path() {
        let err = normalize_asset_payload(ProjectAsset {
            id: "asset-1".into(),
            project_id: "project-1".into(),
            kind: "protocol".into(),
            title: "Runbook".into(),
            path: Some("docs/runbook.md".into()),
            content: None,
            description: String::new(),
            created_at: 1,
            updated_at: 1,
        })
        .unwrap_err();

        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn asset_payload_accepts_protocol_markdown_path() {
        let path = std::env::temp_dir().join(format!("swarm-ui-protocol-{}.md", unix_millis()));
        fs::write(&path, "# Runbook").unwrap();

        let asset = normalize_asset_payload(ProjectAsset {
            id: "asset-1".into(),
            project_id: "project-1".into(),
            kind: "protocol".into(),
            title: "Runbook".into(),
            path: Some(path.to_string_lossy().into_owned()),
            content: None,
            description: String::new(),
            created_at: 1,
            updated_at: 1,
        })
        .unwrap();

        assert_eq!(asset.kind, "protocol");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn create_project_note_asset_writes_workspace_markdown() {
        let root = std::env::temp_dir().join(format!("swarm-ui-canvas-note-{}", unix_millis()));
        fs::create_dir_all(&root).unwrap();
        let db_path = root.join("swarm-test.db");
        let conn = writes::open_rw_at(&db_path).unwrap();
        let project = ProjectSpace {
            id: "project-1".into(),
            name: "Canvas".into(),
            root: root.to_string_lossy().into_owned(),
            color: "#ffffff".into(),
            additional_roots: vec![],
            notes: String::new(),
            scope: None,
            boundary: ProjectBoundary {
                x: 0.0,
                y: 0.0,
                width: 720.0,
                height: 420.0,
            },
            created_at: 1,
            updated_at: 1,
        };
        writes::save_project(&conn, &project).unwrap();

        let asset = write_project_note_asset_record(
            &conn,
            "project-1",
            "Decision Log",
            Some("Keep assets visible on the canvas.".into()),
        )
        .unwrap();

        let path = PathBuf::from(asset.path.as_deref().unwrap());
        assert_eq!(asset.kind, "note");
        assert!(path.starts_with(root.join(PROJECT_WORKSPACE_DIR)));
        assert!(path.exists());
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "Keep assets visible on the canvas.\n"
        );
        let saved = writes::load_project_asset(&conn, &asset.id)
            .unwrap()
            .unwrap();
        assert_eq!(saved.path, asset.path);
    }

    #[test]
    fn update_project_note_asset_content_rewrites_markdown_file() {
        let root =
            std::env::temp_dir().join(format!("swarm-ui-canvas-note-edit-{}", unix_millis()));
        fs::create_dir_all(&root).unwrap();
        let db_path = root.join("swarm-test.db");
        let conn = writes::open_rw_at(&db_path).unwrap();
        let project = ProjectSpace {
            id: "project-1".into(),
            name: "Canvas".into(),
            root: root.to_string_lossy().into_owned(),
            color: "#ffffff".into(),
            additional_roots: vec![],
            notes: String::new(),
            scope: None,
            boundary: ProjectBoundary {
                x: 0.0,
                y: 0.0,
                width: 720.0,
                height: 420.0,
            },
            created_at: 1,
            updated_at: 1,
        };
        writes::save_project(&conn, &project).unwrap();
        let asset =
            write_project_note_asset_record(&conn, "project-1", "Canvas Note", None).unwrap();

        let updated = write_project_text_asset_content(
            &conn,
            &asset.id,
            "# Canvas Note\n\nEdited directly on the canvas.",
        )
        .unwrap();
        let path = PathBuf::from(updated.path.as_deref().unwrap());

        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "# Canvas Note\n\nEdited directly on the canvas.\n"
        );
        assert_eq!(
            updated.content.as_deref().unwrap(),
            "# Canvas Note\n\nEdited directly on the canvas.\n"
        );
        assert!(updated.updated_at >= asset.updated_at);
    }

    #[test]
    fn extract_response_text_reads_responses_output_text() {
        let value = json!({
            "output": [{
                "content": [{
                    "type": "output_text",
                    "text": "  Visual summary for agents.  "
                }]
            }]
        });

        assert_eq!(
            extract_response_text(&value).as_deref(),
            Some("Visual summary for agents.")
        );
    }

    #[test]
    fn analyze_project_asset_persists_visual_analysis() {
        let root = std::env::temp_dir().join(format!("swarm-ui-analyze-{}", unix_millis()));
        fs::create_dir_all(&root).unwrap();
        let image_path = root.join("launch.png");
        fs::write(&image_path, b"fake png bytes").unwrap();
        let db_path = root.join("swarm-test.db");
        let conn = writes::open_rw_at(&db_path).unwrap();
        let project = ProjectSpace {
            id: "project-1".into(),
            name: "Analyze".into(),
            root: root.to_string_lossy().into_owned(),
            color: "#ffffff".into(),
            additional_roots: vec![],
            notes: String::new(),
            scope: None,
            boundary: ProjectBoundary {
                x: 0.0,
                y: 0.0,
                width: 720.0,
                height: 420.0,
            },
            created_at: 1,
            updated_at: 1,
        };
        writes::save_project(&conn, &project).unwrap();
        writes::save_project_asset(
            &conn,
            &ProjectAsset {
                id: "asset-1".into(),
                project_id: "project-1".into(),
                kind: "image".into(),
                title: "Launch screenshot".into(),
                path: Some(image_path.to_string_lossy().into_owned()),
                content: None,
                description: "Terminal launch state".into(),
                created_at: 10,
                updated_at: 10,
            },
        )
        .unwrap();

        let analyzed = analyze_project_asset_with_runner(&conn, "asset-1", |asset, path| {
            assert_eq!(asset.title, "Launch screenshot");
            assert_eq!(path, image_path.as_path());
            Ok("Dark launch UI with an empty terminal panel.".into())
        })
        .unwrap();

        assert_eq!(
            analyzed.content.as_deref(),
            Some("Dark launch UI with an empty terminal panel.")
        );
        assert!(analyzed.updated_at >= 10);
        let reloaded = writes::load_project_asset(&conn, "asset-1")
            .unwrap()
            .unwrap();
        assert_eq!(reloaded.content, analyzed.content);
        let artifact_path = root
            .join(PROJECT_WORKSPACE_DIR)
            .join(current_local_date_slug())
            .join("visual-analysis-launch-screenshot-asset1.md");
        let artifact = fs::read_to_string(&artifact_path).unwrap();
        assert!(artifact.contains("# Visual Analysis - Launch screenshot"));
        assert!(artifact.contains("Dark launch UI with an empty terminal panel."));
        assert!(root.join(PROJECT_WORKSPACE_DIR).join("README.md").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn analyze_project_asset_rejects_non_visual_assets() {
        let root = std::env::temp_dir().join(format!("swarm-ui-analyze-note-{}", unix_millis()));
        fs::create_dir_all(&root).unwrap();
        let db_path = root.join("swarm-test.db");
        let conn = writes::open_rw_at(&db_path).unwrap();
        let project = ProjectSpace {
            id: "project-1".into(),
            name: "Analyze".into(),
            root: root.to_string_lossy().into_owned(),
            color: "#ffffff".into(),
            additional_roots: vec![],
            notes: String::new(),
            scope: None,
            boundary: ProjectBoundary {
                x: 0.0,
                y: 0.0,
                width: 720.0,
                height: 420.0,
            },
            created_at: 1,
            updated_at: 1,
        };
        writes::save_project(&conn, &project).unwrap();
        writes::save_project_asset(
            &conn,
            &ProjectAsset {
                id: "asset-1".into(),
                project_id: "project-1".into(),
                kind: "note".into(),
                title: "Notes".into(),
                path: None,
                content: Some("Text only".into()),
                description: String::new(),
                created_at: 10,
                updated_at: 10,
            },
        )
        .unwrap();

        let err = analyze_project_asset_with_runner(&conn, "asset-1", |_asset, _path| {
            Ok("should not run".into())
        })
        .unwrap_err();

        assert!(matches!(err, AppError::Validation(_)));
        assert!(err.to_string().contains("image and screenshot"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_text_asset_content_strips_rtf_markup() {
        let path = std::env::temp_dir().join(format!("swarm-ui-notes-{}.rtf", unix_millis()));
        fs::write(&path, r"{\rtf1\ansi Field notes\par Second line}").unwrap();

        let content = read_text_asset_content(&path).unwrap();

        assert_eq!(content, "Field notes\nSecond line");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn discover_project_asset_candidates_imports_text_files_from_project_root() {
        let root = std::env::temp_dir().join(format!("swarm-ui-assets-import-{}", unix_millis()));
        fs::create_dir_all(&root).unwrap();
        let note_path = root.join("field-notes.txt");
        fs::write(&note_path, "Launch window opens at 09:00.").unwrap();
        let project = ProjectSpace {
            id: "project-1".into(),
            name: "New Times".into(),
            root: root.to_string_lossy().into_owned(),
            color: "#ffffff".into(),
            additional_roots: vec![],
            notes: String::new(),
            scope: None,
            boundary: ProjectBoundary {
                x: 0.0,
                y: 0.0,
                width: 720.0,
                height: 420.0,
            },
            created_at: 1,
            updated_at: 1,
        };

        let candidates = discover_project_asset_candidates(&project, &[]).unwrap();

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].kind, "note");
        assert_eq!(candidates[0].title, "field-notes");
        assert_eq!(
            candidates[0].path.as_deref(),
            Some(note_path.to_string_lossy().as_ref())
        );
        assert_eq!(
            candidates[0].content.as_deref(),
            Some("Launch window opens at 09:00.")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn discover_project_asset_candidates_skips_existing_paths() {
        let root = std::env::temp_dir().join(format!("swarm-ui-assets-existing-{}", unix_millis()));
        fs::create_dir_all(&root).unwrap();
        let note_path = root.join("field-notes.txt");
        fs::write(&note_path, "Already indexed.").unwrap();
        let project = ProjectSpace {
            id: "project-1".into(),
            name: "New Times".into(),
            root: root.to_string_lossy().into_owned(),
            color: "#ffffff".into(),
            additional_roots: vec![],
            notes: String::new(),
            scope: None,
            boundary: ProjectBoundary {
                x: 0.0,
                y: 0.0,
                width: 720.0,
                height: 420.0,
            },
            created_at: 1,
            updated_at: 1,
        };
        let existing = ProjectAsset {
            id: "asset-1".into(),
            project_id: "project-1".into(),
            kind: "note".into(),
            title: "field-notes".into(),
            path: Some(note_path.to_string_lossy().into_owned()),
            content: None,
            description: String::new(),
            created_at: 1,
            updated_at: 1,
        };

        let candidates = discover_project_asset_candidates(&project, &[existing]).unwrap();

        assert!(candidates.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn project_asset_catalog_reports_import_count_and_scanned_roots() {
        let root = std::env::temp_dir().join(format!("swarm-ui-refresh-{}", unix_millis()));
        fs::create_dir_all(&root).unwrap();
        let note_path = root.join("refresh-note.txt");
        fs::write(&note_path, "Refresh should discover this.").unwrap();
        let db_path = root.join("swarm-test.db");
        let conn = writes::open_rw_at(&db_path).unwrap();
        let project = ProjectSpace {
            id: "project-1".into(),
            name: "New Times".into(),
            root: root.to_string_lossy().into_owned(),
            color: "#ffffff".into(),
            additional_roots: vec![],
            notes: String::new(),
            scope: None,
            boundary: ProjectBoundary {
                x: 0.0,
                y: 0.0,
                width: 720.0,
                height: 420.0,
            },
            created_at: 1,
            updated_at: 1,
        };
        writes::save_project(&conn, &project).unwrap();

        let catalog = refresh_project_asset_catalog(&conn, "project-1").unwrap();

        assert_eq!(catalog.imported_count, 1);
        assert_eq!(
            catalog.scanned_roots,
            vec![root.to_string_lossy().to_string()]
        );
        assert_eq!(catalog.assets.len(), 1);
        assert_eq!(
            catalog.assets[0].content.as_deref(),
            Some("Refresh should discover this.")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn project_asset_catalog_includes_root_inventory() {
        let root = std::env::temp_dir().join(format!("swarm-ui-inventory-{}", unix_millis()));
        fs::create_dir_all(root.join("references")).unwrap();
        fs::create_dir_all(root.join("references").join("nested")).unwrap();
        fs::write(root.join("notes.rtf"), r"{\rtf1\ansi Rich notes}").unwrap();
        fs::write(root.join("references").join("logo.jpeg"), b"fake image").unwrap();
        fs::write(
            root.join("references").join("nested").join("brief.txt"),
            "Nested notes",
        )
        .unwrap();
        let db_path = root.join("swarm-test.db");
        let conn = writes::open_rw_at(&db_path).unwrap();
        let project = ProjectSpace {
            id: "project-1".into(),
            name: "New Times".into(),
            root: root.to_string_lossy().into_owned(),
            color: "#ffffff".into(),
            additional_roots: vec![],
            notes: String::new(),
            scope: None,
            boundary: ProjectBoundary {
                x: 0.0,
                y: 0.0,
                width: 720.0,
                height: 420.0,
            },
            created_at: 1,
            updated_at: 1,
        };
        writes::save_project(&conn, &project).unwrap();

        let catalog = refresh_project_asset_catalog(&conn, "project-1").unwrap();

        assert!(
            catalog
                .inventory
                .iter()
                .any(|entry| { entry.name == "references" && entry.entry_type == "folder" })
        );
        assert!(
            catalog
                .inventory
                .iter()
                .any(|entry| { entry.name == "notes.rtf" && entry.category == "richText" })
        );
        assert!(
            catalog
                .inventory
                .iter()
                .any(|entry| { entry.name == "logo.jpeg" && entry.category == "image" })
        );
        assert!(
            catalog
                .inventory
                .iter()
                .any(|entry| { entry.name == "brief.txt" && entry.category == "text" })
        );
        let _ = fs::remove_dir_all(root);
    }
}

/// Fan-out an operator-authored message to every agent in `scope`. Writes one
/// row per recipient and emits a `message.broadcast` event so ConnectionEdges
/// animate. The sender id is synthesised as `operator:<scope>` to avoid
/// colliding with any real instance id.
///
/// Called from the Conversation panel's message bar. Returns the number of
/// recipient rows inserted — `0` means the scope is empty and nothing was sent.
#[tauri::command]
pub fn ui_broadcast_message(scope: String, content: String) -> Result<usize, AppError> {
    let trimmed_scope = scope.trim();
    let trimmed_content = content.trim();
    if trimmed_scope.is_empty() {
        return Err(AppError::Validation("scope is required".into()));
    }
    if trimmed_content.is_empty() {
        return Err(AppError::Validation("message content is required".into()));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    let sender = format!("operator:{trimmed_scope}");
    writes::broadcast_from_operator(&conn, trimmed_scope, &sender, trimmed_content)
        .map_err(AppError::Operation)
}

/// Send an operator-authored direct message to one agent in `scope`. This is
/// the targeted companion to `ui_broadcast_message` for the Conversation panel
/// recipient picker.
#[tauri::command]
pub fn ui_send_message(
    scope: String,
    recipient: String,
    content: String,
) -> Result<bool, AppError> {
    let trimmed_scope = scope.trim();
    let trimmed_recipient = recipient.trim();
    let trimmed_content = content.trim();
    if trimmed_scope.is_empty() {
        return Err(AppError::Validation("scope is required".into()));
    }
    if trimmed_recipient.is_empty() {
        return Err(AppError::Validation("recipient is required".into()));
    }
    if trimmed_content.is_empty() {
        return Err(AppError::Validation("message content is required".into()));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    let sender = format!("operator:{trimmed_scope}");
    writes::send_from_operator(
        &conn,
        trimmed_scope,
        &sender,
        trimmed_recipient,
        trimmed_content,
    )
    .map_err(AppError::Operation)
}

/// Send a Ctrl-C (0x03) to every PTY bound to an instance in `scope`. This is
/// the "Stop" button in the Conversation panel — a soft halt that drops each
/// agent's harness back to its shell prompt without killing the process tree.
/// Only PTYs the UI still has a binder resolution for are signalled; externally
/// adopted agents (no bound PTY in this UI session) are skipped by necessity.
///
/// Returns the count of PTYs that received the interrupt. Failures on
/// individual writes are logged but don't abort the fan-out.
#[tauri::command]
pub fn ui_send_sigint_scope(
    binder: State<'_, Binder>,
    manager: State<'_, PtyManager>,
    scope: String,
) -> Result<usize, AppError> {
    let trimmed = scope.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("scope is required".into()));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    let instance_ids =
        writes::list_scope_instance_ids(&conn, trimmed).map_err(AppError::Operation)?;

    let mut count = 0usize;
    for instance_id in instance_ids {
        let Some(pty_id) = binder.resolved_pty_for(&instance_id) else {
            continue;
        };
        match manager.write_input(&pty_id, &[0x03]) {
            Ok(()) => count += 1,
            Err(err) => eprintln!(
                "[ui_send_sigint_scope] failed to SIGINT pty {pty_id} for instance {instance_id}: {err:?}"
            ),
        }
    }
    Ok(count)
}

/// Kill the OS process backing `instance_id`, then deregister the swarm row.
///
/// This exists because the previous "remove" path (`ui_deregister_instance` /
/// `ui_force_deregister_instance`) only closed PTYs that the current UI session
/// still owned. Instances adopted by an externally-spawned Claude (`flux` in a
/// Terminal.app tab, a `bun test` runner, etc.) left their OS process running
/// after the swarm row was dropped — so the red icon looked like it worked but
/// the bun/claude process continued burning tokens.
///
/// Behaviour:
///   - Load the row to get `pid`. Reject if the row is missing.
///   - If a binder resolution exists in this UI session, close the PTY via the
///     daemon first (best-effort, errors swallowed — the user's intent is
///     unambiguous).
///   - If `pid > 0` and `pid != current process pid`, `kill -TERM <pid>`; then
///     wait 1500 ms; then `kill -0 <pid>` to see if it's still alive; if so,
///     `kill -KILL <pid>`. Errors are logged but do not block deregistration —
///     a race where the process already exited (pid=0 / ESRCH) is expected.
///   - Always call `writes::deregister_instance` so the row and its cascading
///     cleanup (locks, queued messages, claimed tasks) happen even if the kill
///     syscall fails.
///   - Unconditionally drop the binder mapping.
///
/// The frontend gates this behind the red-icon confirm dialog.
#[tauri::command]
pub async fn ui_kill_instance(
    binder: State<'_, Binder>,
    instance_id: String,
) -> Result<(), AppError> {
    let trimmed = instance_id.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("instance_id is required".into()));
    }
    kill_target_internal(
        &binder,
        KillTarget::BoundInstance {
            instance_id: trimmed.to_owned(),
        },
    )
    .await?;
    Ok(())
}

use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::PathBuf;

use dirs::config_dir;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};
use uuid::Uuid;

use crate::bind::Binder;
use crate::events::BIND_RESOLVED;
use crate::model::{AppError, InstanceStatus};
use crate::pty::{PtyCreateRequest, PtyManager};
use crate::writes;

const DEFAULT_ROLES: &[&str] = &["planner", "implementer", "reviewer", "researcher"];

#[derive(Debug, Clone, Serialize)]
pub struct RolePresetSummary {
    pub role: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShellSpawnResult {
    pub pty_id: String,
    /// Present only when the shell was launched with a swarm-aware harness
    /// (claude/codex/opencode). Plain shells have no swarm identity.
    pub instance_id: Option<String>,
    /// Echo the role token (if any). The frontend may surface it, but role
    /// guidance itself comes from the explicit `swarm.register` response.
    pub role: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RespawnResult {
    pub pty_id: String,
    pub token: String,
    pub instance_id: String,
    /// Set when the respawn booted a swarm-aware harness shell. The frontend
    /// auto-types this command into the shell's stdin after spawn so the
    /// `spawn_shell` ergonomics carry over (ctrl-c returns to a shell prompt
    /// instead of terminating the PTY node).
    pub harness: Option<String>,
    /// Echo the role token (if any). Role guidance still comes from the
    /// explicit `swarm.register` response after adoption.
    pub role: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LaunchConfigFile {
    roles: Option<Vec<String>>,
}

pub struct LaunchConfig {
    roles: Vec<String>,
}

impl LaunchConfig {
    #[must_use]
    pub fn load() -> Self {
        let mut seen: HashSet<String> = HashSet::new();
        let mut roles: Vec<String> = Vec::new();
        for role in DEFAULT_ROLES {
            if seen.insert((*role).to_owned()) {
                roles.push((*role).to_owned());
            }
        }
        if let Some(extra) = read_launch_config_file().and_then(|file| file.roles) {
            for role in extra {
                let trimmed = role.trim();
                if !trimmed.is_empty() && seen.insert(trimmed.to_owned()) {
                    roles.push(trimmed.to_owned());
                }
            }
        }
        Self { roles }
    }

    fn summaries(&self) -> Vec<RolePresetSummary> {
        self.roles
            .iter()
            .map(|role| RolePresetSummary { role: role.clone() })
            .collect()
    }

    fn is_known(&self, role: &str) -> bool {
        self.roles.iter().any(|known| known == role)
    }
}

fn read_launch_config_file() -> Option<LaunchConfigFile> {
    let path = config_dir_path()?.join("role-presets.json");
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn config_dir_path() -> Option<PathBuf> {
    config_dir().map(|path| path.join("swarm-ui"))
}

fn shell_path() -> String {
    env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned())
}

fn validate_harness_name(harness: Option<&str>) -> Result<Option<&str>, AppError> {
    let Some(harness) = harness.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    if is_harness_shell_role(harness) {
        Ok(Some(harness))
    } else {
        Err(AppError::Validation(format!(
            "unsupported shell harness: {harness}"
        )))
    }
}

fn validate_role(
    role: Option<&str>,
    launch_config: &LaunchConfig,
) -> Result<Option<String>, AppError> {
    let Some(role) = role.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    if launch_config.is_known(role) {
        Ok(Some(role.to_owned()))
    } else {
        Err(AppError::Validation(format!("unknown role: {role}")))
    }
}

/// Validate a user-supplied agent name. Names ride inside the swarm label as a
/// `name:<value>` token, which is whitespace/colon-separated, so we restrict
/// the character set to letters, digits, dashes, dots, and underscores.
fn validate_name(name: Option<&str>) -> Result<Option<String>, AppError> {
    let Some(name) = name.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    if name.len() > 32 {
        return Err(AppError::Validation(
            "name must be 32 characters or fewer".into(),
        ));
    }

    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(AppError::Validation(
            "name may only contain letters, digits, dashes, dots, and underscores".into(),
        ));
    }

    Ok(Some(name.to_owned()))
}

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

fn build_label(
    role: Option<&str>,
    name: Option<&str>,
    token: &str,
    preset_label_tokens: &str,
    extra_label_tokens: Option<&str>,
) -> String {
    let mut ordered = Vec::new();
    let mut seen = HashSet::new();

    let mut push_tokens = |value: &str| {
        for token in value.split_whitespace() {
            if seen.insert(token.to_owned()) {
                ordered.push(token.to_owned());
            }
        }
    };

    if let Some(name) = name {
        push_tokens(&format!("name:{name}"));
    }
    if let Some(role) = role {
        push_tokens(&format!("role:{role}"));
    }
    push_tokens(&format!("launch:{token}"));
    push_tokens(preset_label_tokens);
    if let Some(extra_label_tokens) = extra_label_tokens {
        push_tokens(extra_label_tokens);
    }

    ordered.join(" ")
}

fn launch_token() -> String {
    Uuid::new_v4().simple().to_string()[..8].to_owned()
}

fn validate_working_dir(dir: &str) -> Result<(), AppError> {
    if dir.is_empty() {
        return Err(AppError::Validation(
            "working directory must not be empty".into(),
        ));
    }
    let path = std::path::Path::new(dir);
    if !path.is_absolute() {
        return Err(AppError::Validation(
            "working directory must be an absolute path".into(),
        ));
    }
    if !path.is_dir() {
        return Err(AppError::Validation(format!(
            "working directory does not exist: {dir}"
        )));
    }
    Ok(())
}

#[tauri::command]
#[must_use]
pub fn get_role_presets(launch_config: State<'_, LaunchConfig>) -> Vec<RolePresetSummary> {
    launch_config.summaries()
}

/// Launch an interactive shell. When `harness` names a swarm-aware CLI
/// (claude/codex/opencode) the backend pre-creates a swarm instance row,
/// injects the env vars the harness's MCP subprocess needs to adopt it, and
/// emits `bind:resolved` immediately so the node renders as bound. The
/// frontend auto-types `harness` into the shell after spawn so ctrl-c drops
/// back to the shell prompt instead of terminating the PTY.
///
/// `role` adds a `role:<role>` token to the swarm label. The MCP server reads
/// the label on adoption (auto-adopt) and the `register` tool returns
/// role-specific bootstrap text. Without a harness, `role` is ignored —
/// there's no MCP server to adopt the row.
#[tauri::command]
#[allow(clippy::unused_async, clippy::too_many_arguments)]
pub async fn spawn_shell(
    app_handle: AppHandle,
    pty_manager: State<'_, PtyManager>,
    binder: State<'_, Binder>,
    launch_config: State<'_, LaunchConfig>,
    cwd: String,
    harness: Option<String>,
    role: Option<String>,
    scope: Option<String>,
    label: Option<String>,
    name: Option<String>,
) -> Result<ShellSpawnResult, AppError> {
    spawn_shell_impl(
        &app_handle,
        &pty_manager,
        &binder,
        &launch_config,
        cwd,
        harness,
        role,
        scope,
        label,
        name,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_shell_impl<R: Runtime>(
    app_handle: &AppHandle<R>,
    pty_manager: &PtyManager,
    binder: &Binder,
    launch_config: &LaunchConfig,
    cwd: String,
    harness: Option<String>,
    role: Option<String>,
    scope: Option<String>,
    label: Option<String>,
    name: Option<String>,
) -> Result<ShellSpawnResult, AppError> {
    validate_working_dir(&cwd)?;

    let shell = shell_path();
    let harness_cmd = validate_harness_name(harness.as_deref())?;
    let validated_role = validate_role(role.as_deref(), launch_config)?;
    let validated_name = validate_name(name.as_deref())?;
    let display_command = harness_cmd.map_or_else(|| shell.clone(), str::to_owned);

    let mut env = HashMap::new();
    let mut response_role: Option<String> = None;
    let instance_id = if let Some(harness_name) = harness_cmd {
        let token = launch_token();
        let label_string = build_label(
            validated_role.as_deref(),
            validated_name.as_deref(),
            &token,
            &format!("provider:{harness_name}"),
            label.as_deref(),
        );

        let conn = writes::open_rw().map_err(AppError::Operation)?;
        writes::ensure_adopted_column(&conn).map_err(AppError::Operation)?;
        let pending = writes::create_pending_instance(
            &conn,
            &cwd,
            scope.as_deref(),
            Some(&label_string),
            None,
        )
        .map_err(AppError::Operation)?;
        drop(conn);

        env.insert("SWARM_MCP_INSTANCE_ID".to_owned(), pending.id.clone());
        env.insert("SWARM_MCP_SCOPE".to_owned(), pending.scope.clone());
        env.insert("SWARM_MCP_LABEL".to_owned(), label_string);
        env.insert("SWARM_UI_LAUNCH_TOKEN".to_owned(), token);
        env.insert(
            "SWARM_UI_ROLE".to_owned(),
            validated_role
                .clone()
                .unwrap_or_else(|| harness_name.to_owned()),
        );
        response_role = validated_role;
        Some(pending.id)
    } else {
        None
    };

    let pty_id = match pty_manager.create_session(
        app_handle,
        PtyCreateRequest {
            command: shell,
            args: Vec::new(),
            cwd,
            env,
            display_command: Some(display_command),
        },
    ) {
        Ok(id) => id,
        Err(err) => {
            if let Some(id) = instance_id.as_deref() {
                let _ = writes::open_rw().and_then(|rollback_conn| {
                    writes::delete_unadopted_instance(&rollback_conn, id).map(|_| ())
                });
            }
            return Err(err);
        }
    };

    if let Some(id) = instance_id.as_deref() {
        pty_manager.set_bound_instance(&pty_id, id)?;
        binder
            .bind_immediate(id, &pty_id)
            .map_err(AppError::Internal)?;
        let _ = app_handle.emit(
            BIND_RESOLVED,
            serde_json::json!({
                "instance_id": id,
                "pty_id": pty_id,
            }),
        );
    }

    Ok(ShellSpawnResult {
        pty_id,
        instance_id,
        role: response_role,
    })
}

/// Extract the harness name from a label's `provider:` token. Falls back to
/// the legacy convention where `role:claude`/`role:codex`/`role:opencode`
/// implied the harness, so labels written before the unified-launcher refactor
/// still respawn correctly.
fn parse_harness_from_label(label: Option<&str>) -> Option<String> {
    let label = label?;
    if let Some(provider) = label
        .split_whitespace()
        .find_map(|token| token.strip_prefix("provider:"))
    {
        if is_harness_shell_role(provider) {
            return Some(provider.to_owned());
        }
    }
    parse_role_from_label(Some(label))
        .filter(|candidate| is_harness_shell_role(candidate))
}

/// Extract `role:X` from a label token list.
fn parse_role_from_label(label: Option<&str>) -> Option<String> {
    label?
        .split_whitespace()
        .find_map(|token| token.strip_prefix("role:"))
        .map(str::to_owned)
}

fn is_harness_shell_role(role: &str) -> bool {
    matches!(role, "claude" | "codex" | "opencode")
}

/// Relaunch a PTY against an existing (offline/stale) swarm instance row so
/// the user can pick up where a previous swarm-ui session left off.
///
/// The child process inherits `SWARM_MCP_INSTANCE_ID`, so its `swarm.register`
/// call re-adopts the existing row — updating pid + heartbeat without
/// creating a duplicate. Tasks, locks, and message history keyed to the
/// instance id stay intact.
#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn respawn_instance(
    app_handle: AppHandle,
    pty_manager: State<'_, PtyManager>,
    binder: State<'_, Binder>,
    instance_id: String,
) -> Result<RespawnResult, AppError> {
    let trimmed = instance_id.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("instance_id is required".into()));
    }

    if binder.resolved_pty_for(trimmed).is_some() {
        return Err(AppError::Validation(format!(
            "instance {trimmed} already has a live PTY in this session"
        )));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::ensure_adopted_column(&conn).map_err(AppError::Operation)?;
    let existing = writes::load_instance_info(&conn, trimmed)
        .map_err(AppError::Operation)?
        .ok_or_else(|| AppError::NotFound(format!("instance {trimmed} not found")))?;
    drop(conn);

    let status = instance_status_from_heartbeat(existing.heartbeat);
    if status == InstanceStatus::Online {
        return Err(AppError::Validation(format!(
            "instance {trimmed} is still {} and cannot be respawned",
            instance_status_label(status)
        )));
    }

    validate_working_dir(&existing.directory)?;

    let harness = parse_harness_from_label(existing.label.as_deref()).ok_or_else(|| {
        AppError::Validation(format!(
            "instance {trimmed} has no harness in its label — cannot determine respawn command"
        ))
    })?;
    let role = parse_role_from_label(existing.label.as_deref())
        .filter(|candidate| !is_harness_shell_role(candidate));

    let token = launch_token();
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("SWARM_MCP_INSTANCE_ID".to_owned(), existing.id.clone());
    env.insert("SWARM_MCP_SCOPE".to_owned(), existing.scope.clone());
    if let Some(label) = existing.label.clone() {
        env.insert("SWARM_MCP_LABEL".to_owned(), label);
    }
    env.insert("SWARM_UI_LAUNCH_TOKEN".to_owned(), token.clone());
    env.insert(
        "SWARM_UI_ROLE".to_owned(),
        role.clone().unwrap_or_else(|| harness.clone()),
    );

    let pty_id = pty_manager.create_session(
        &app_handle,
        PtyCreateRequest {
            command: shell_path(),
            args: Vec::new(),
            cwd: existing.directory.clone(),
            env,
            display_command: Some(harness.clone()),
        },
    )?;

    pty_manager.set_launch_token(&pty_id, &token)?;
    pty_manager.set_bound_instance(&pty_id, &existing.id)?;
    binder
        .bind_immediate(&existing.id, &pty_id)
        .map_err(AppError::Internal)?;

    let _ = app_handle.emit(
        BIND_RESOLVED,
        serde_json::json!({
            "token": token,
            "instance_id": existing.id,
            "pty_id": pty_id,
        }),
    );

    Ok(RespawnResult {
        pty_id,
        token,
        instance_id: existing.id,
        harness: Some(harness),
        role,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_label_includes_role_and_token() {
        let label = build_label(Some("planner"), None, "abc", "provider:oc", None);
        assert!(label.contains("role:planner"));
        assert!(label.contains("launch:abc"));
        assert!(label.contains("provider:oc"));
    }

    #[test]
    fn build_label_deduplicates_tokens() {
        let label = build_label(
            Some("planner"),
            None,
            "abc",
            "provider:oc",
            Some("provider:oc extra:tag"),
        );
        assert_eq!(label.matches("provider:oc").count(), 1);
        assert!(label.contains("extra:tag"));
    }

    #[test]
    fn build_label_without_role() {
        let label = build_label(None, None, "abc", "provider:oc", None);
        assert!(!label.contains("role:"));
        assert!(label.contains("launch:abc"));
    }

    #[test]
    fn build_label_includes_name_token() {
        let label = build_label(Some("planner"), Some("scout"), "abc", "provider:oc", None);
        assert!(label.contains("name:scout"));
        assert!(label.contains("role:planner"));
    }

    #[test]
    fn validate_name_rejects_whitespace_and_colons() {
        assert!(validate_name(Some("hello world")).is_err());
        assert!(validate_name(Some("name:thing")).is_err());
        assert!(validate_name(Some("planner!")).is_err());
    }

    #[test]
    fn validate_name_accepts_safe_characters() {
        assert_eq!(
            validate_name(Some("front-end_2.0")).unwrap(),
            Some("front-end_2.0".to_owned())
        );
    }

    #[test]
    fn validate_name_rejects_overlong_input() {
        let long = "a".repeat(33);
        assert!(validate_name(Some(&long)).is_err());
    }

    #[test]
    fn validate_name_treats_blank_as_none() {
        assert_eq!(validate_name(None).unwrap(), None);
        assert_eq!(validate_name(Some("   ")).unwrap(), None);
    }

    #[test]
    fn validate_working_dir_rejects_empty() {
        assert!(validate_working_dir("").is_err());
    }

    #[test]
    fn validate_working_dir_rejects_relative() {
        assert!(validate_working_dir("relative/path").is_err());
    }

    #[test]
    fn validate_working_dir_rejects_nonexistent() {
        assert!(validate_working_dir("/nonexistent/should/not/exist").is_err());
    }

    #[test]
    fn validate_working_dir_accepts_tmp() {
        assert!(validate_working_dir("/tmp").is_ok());
    }

    #[test]
    fn parse_role_from_label_happy_path() {
        assert_eq!(
            parse_role_from_label(Some("role:planner launch:abc provider:opencode")),
            Some("planner".to_owned())
        );
    }

    #[test]
    fn parse_role_from_label_returns_none_without_role_token() {
        assert_eq!(
            parse_role_from_label(Some("launch:abc provider:opencode")),
            None
        );
    }

    #[test]
    fn parse_role_from_label_none_when_empty() {
        assert_eq!(parse_role_from_label(None), None);
        assert_eq!(parse_role_from_label(Some("")), None);
    }

    #[test]
    fn parse_harness_from_label_uses_provider_token() {
        assert_eq!(
            parse_harness_from_label(Some("role:planner launch:abc provider:claude")),
            Some("claude".to_owned())
        );
    }

    #[test]
    fn parse_harness_from_label_falls_back_to_legacy_role_token() {
        // Pre-refactor labels used `role:claude` to mean the harness.
        assert_eq!(
            parse_harness_from_label(Some("role:codex launch:abc")),
            Some("codex".to_owned())
        );
    }

    #[test]
    fn parse_harness_from_label_returns_none_without_provider_or_legacy_role() {
        assert_eq!(
            parse_harness_from_label(Some("role:planner launch:abc")),
            None
        );
        assert_eq!(parse_harness_from_label(Some("launch:abc")), None);
        assert_eq!(parse_harness_from_label(None), None);
    }

    #[test]
    fn is_harness_shell_role_recognizes_harnesses() {
        assert!(is_harness_shell_role("claude"));
        assert!(is_harness_shell_role("codex"));
        assert!(is_harness_shell_role("opencode"));
        assert!(!is_harness_shell_role("planner"));
        assert!(!is_harness_shell_role("implementer"));
    }

    #[test]
    fn validate_harness_name_rejects_unknown_harnesses() {
        assert!(validate_harness_name(Some("claude")).is_ok());
        assert!(validate_harness_name(Some("unknown")).is_err());
        assert_eq!(validate_harness_name(Some("  ")).unwrap(), None);
    }

    #[test]
    fn launch_config_includes_default_roles() {
        let config = LaunchConfig {
            roles: DEFAULT_ROLES.iter().map(|r| (*r).to_owned()).collect(),
        };
        assert!(config.is_known("planner"));
        assert!(config.is_known("implementer"));
        assert!(!config.is_known("nonsense"));
    }

    #[test]
    fn validate_role_allows_none() {
        let config = LaunchConfig {
            roles: vec!["planner".into()],
        };
        assert_eq!(validate_role(None, &config).unwrap(), None);
        assert_eq!(validate_role(Some("  "), &config).unwrap(), None);
    }

    #[test]
    fn validate_role_accepts_known_role() {
        let config = LaunchConfig {
            roles: vec!["planner".into()],
        };
        assert_eq!(
            validate_role(Some("planner"), &config).unwrap(),
            Some("planner".to_owned())
        );
    }

    #[test]
    fn validate_role_rejects_unknown_role() {
        let config = LaunchConfig {
            roles: vec!["planner".into()],
        };
        assert!(validate_role(Some("ghost"), &config).is_err());
    }
}

use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use dirs::config_dir;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::bind::Binder;
use crate::events::BIND_RESOLVED;
use crate::model::AppError;
use crate::pty::{PtyCreateRequest, PtyManager};
use crate::writes;

#[derive(Debug, Clone)]
struct RolePreset {
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    default_label_tokens: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RolePresetSummary {
    pub role: String,
    pub command: String,
    pub args: Vec<String>,
    pub default_label_tokens: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LaunchResult {
    pub pty_id: String,
    pub token: String,
    /// Pre-created swarm instance id bound to this PTY. The child process
    /// adopts this row when it calls `swarm.register` with
    /// `SWARM_MCP_INSTANCE_ID` set.
    pub instance_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShellSpawnResult {
    pub pty_id: String,
    /// Present only when the shell was launched with a swarm-aware harness
    /// (claude/codex/opencode). Plain shells have no swarm identity.
    pub instance_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LaunchConfigFile {
    agent_command: Option<String>,
    presets: Option<HashMap<String, ConfigRolePreset>>,
}

#[derive(Debug, Deserialize)]
struct ConfigRolePreset {
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    default_label_tokens: Option<String>,
}

#[derive(Debug)]
struct ResolvedCommand {
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    display_command: String,
    default_label_tokens: String,
}

pub struct LaunchConfig {
    presets: HashMap<String, RolePreset>,
}

impl LaunchConfig {
    #[must_use]
    pub fn load() -> Self {
        let file_config = read_launch_config_file();
        let agent_command = env::var("SWARM_UI_AGENT_COMMAND")
            .ok()
            .or_else(|| {
                file_config
                    .as_ref()
                    .and_then(|config| config.agent_command.clone())
            })
            .unwrap_or_else(|| "opencode".to_owned());
        let provider = binary_basename(&agent_command);

        let mut presets = default_presets(&agent_command, &provider);
        if let Some(config) = file_config {
            for (role, override_preset) in config.presets.unwrap_or_default() {
                let mut preset = presets.remove(&role).unwrap_or_else(|| RolePreset {
                    command: agent_command.clone(),
                    args: Vec::new(),
                    env: HashMap::new(),
                    default_label_tokens: format!("provider:{provider}"),
                });

                if let Some(command) = override_preset.command {
                    preset.command = command;
                }
                if let Some(args) = override_preset.args {
                    preset.args = args;
                }
                if let Some(env) = override_preset.env {
                    preset.env.extend(env);
                }
                if let Some(label_tokens) = override_preset.default_label_tokens {
                    preset.default_label_tokens = label_tokens;
                }

                presets.insert(role, preset);
            }
        }

        Self { presets }
    }

    fn resolve(
        &self,
        role: Option<&str>,
        command: Option<&str>,
    ) -> Result<ResolvedCommand, String> {
        if let Some(command) = command {
            let shell = shell_path();
            return Ok(ResolvedCommand {
                command: shell.clone(),
                args: vec!["-lc".to_owned(), command.to_owned()],
                env: HashMap::new(),
                display_command: command.to_owned(),
                default_label_tokens: String::new(),
            });
        }

        let role =
            role.ok_or_else(|| "agent_spawn requires either a role or command".to_owned())?;
        let preset = self
            .presets
            .get(role)
            .ok_or_else(|| format!("unknown role preset: {role}"))?;

        Ok(ResolvedCommand {
            command: preset.command.clone(),
            args: preset.args.clone(),
            env: preset.env.clone(),
            display_command: render_command(&preset.command, &preset.args),
            default_label_tokens: preset.default_label_tokens.clone(),
        })
    }

    fn summaries(&self) -> Vec<RolePresetSummary> {
        let mut roles = self.presets.keys().cloned().collect::<Vec<_>>();
        roles.sort_unstable();

        roles
            .into_iter()
            .filter_map(|role| {
                self.presets.get(&role).map(|preset| RolePresetSummary {
                    role,
                    command: preset.command.clone(),
                    args: preset.args.clone(),
                    default_label_tokens: preset.default_label_tokens.clone(),
                })
            })
            .collect()
    }
}

fn default_presets(agent_command: &str, provider: &str) -> HashMap<String, RolePreset> {
    ["planner", "implementer", "reviewer", "researcher"]
        .into_iter()
        .map(|role| {
            (
                role.to_owned(),
                RolePreset {
                    command: agent_command.to_owned(),
                    args: Vec::new(),
                    env: HashMap::from([("SWARM_UI_ROLE".to_owned(), role.to_owned())]),
                    default_label_tokens: format!("provider:{provider}"),
                },
            )
        })
        .collect()
}

fn read_launch_config_file() -> Option<LaunchConfigFile> {
    let path = config_dir_path()?.join("role-presets.json");
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn config_dir_path() -> Option<PathBuf> {
    config_dir().map(|path| path.join("swarm-ui"))
}

fn binary_basename(command: &str) -> String {
    Path::new(command)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(command)
        .to_owned()
}

fn shell_path() -> String {
    env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned())
}

fn render_command(command: &str, args: &[String]) -> String {
    if args.is_empty() {
        command.to_owned()
    } else {
        format!("{} {}", command, args.join(" "))
    }
}

fn build_label(
    role: Option<&str>,
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
#[allow(clippy::unused_async, clippy::too_many_arguments)]
pub async fn agent_spawn(
    app_handle: AppHandle,
    pty_manager: State<'_, PtyManager>,
    binder: State<'_, Binder>,
    launch_config: State<'_, LaunchConfig>,
    role: Option<String>,
    working_dir: String,
    scope: Option<String>,
    label: Option<String>,
    command: Option<String>,
) -> Result<LaunchResult, AppError> {
    validate_working_dir(&working_dir)?;

    let token = launch_token();
    let resolved = launch_config
        .resolve(role.as_deref(), command.as_deref())
        .map_err(AppError::Validation)?;
    let label_string = build_label(
        role.as_deref(),
        &token,
        &resolved.default_label_tokens,
        label.as_deref(),
    );

    // Pre-create the swarm instance row (adopted=0). The child's call to
    // `swarm.register` with SWARM_MCP_INSTANCE_ID will adopt this row
    // instead of creating a duplicate, so drag-to-send-message works the
    // moment the PTY appears instead of waiting for the MCP handshake.
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::ensure_adopted_column(&conn).map_err(AppError::Operation)?;
    let pending = writes::create_pending_instance(
        &conn,
        &working_dir,
        scope.as_deref(),
        Some(&label_string),
        None,
    )
    .map_err(AppError::Operation)?;
    drop(conn);

    let mut env = resolved.env;
    env.insert("SWARM_MCP_LABEL".to_owned(), label_string);
    env.insert("SWARM_UI_LAUNCH_TOKEN".to_owned(), token.clone());
    env.insert("SWARM_MCP_INSTANCE_ID".to_owned(), pending.id.clone());
    env.insert("SWARM_MCP_SCOPE".to_owned(), pending.scope.clone());
    if let Some(role) = role.as_ref() {
        env.insert("SWARM_UI_ROLE".to_owned(), role.clone());
    }

    // Note: when `command` is Some, `resolve()` wraps it in `sh -lc` for
    // execution. This is intentional — the app is a developer tool that
    // spawns agent processes. CSP + freezePrototype are the primary defence
    // against injection from a compromised webview.
    let pty_id = match pty_manager.create_session(
        &app_handle,
        PtyCreateRequest {
            command: resolved.command,
            args: resolved.args,
            cwd: working_dir,
            env,
            display_command: Some(resolved.display_command),
        },
    ) {
        Ok(id) => id,
        Err(err) => {
            // Roll back the pre-created row so we don't leave a zombie.
            let _ = writes::open_rw()
                .and_then(|rollback_conn| {
                    writes::delete_unadopted_instance(&rollback_conn, &pending.id)
                        .map(|_| ())
                });
            return Err(err);
        }
    };

    pty_manager.set_launch_token(&pty_id, &token)?;
    pty_manager.set_bound_instance(&pty_id, &pending.id)?;
    binder
        .bind_immediate(&pending.id, &pty_id)
        .map_err(AppError::Internal)?;

    // Emit the resolved binding so the frontend graph immediately shows a
    // `bound:` node. The child is still expected to call `swarm.register`
    // with SWARM_MCP_INSTANCE_ID to flip `adopted = 1`; until then the
    // NodeHeader will render an "adopting" indicator.
    let _ = app_handle.emit(
        BIND_RESOLVED,
        serde_json::json!({
            "token": token,
            "instance_id": pending.id,
            "pty_id": pty_id,
        }),
    );

    Ok(LaunchResult {
        pty_id,
        token,
        instance_id: pending.id,
    })
}

#[tauri::command]
#[must_use]
pub fn get_role_presets(launch_config: State<'_, LaunchConfig>) -> Vec<RolePresetSummary> {
    launch_config.summaries()
}

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn spawn_shell(
    app_handle: AppHandle,
    pty_manager: State<'_, PtyManager>,
    binder: State<'_, Binder>,
    cwd: String,
    harness: Option<String>,
) -> Result<ShellSpawnResult, AppError> {
    validate_working_dir(&cwd)?;

    // Always spawn a plain interactive login shell. When a harness is
    // requested, the frontend auto-types the harness command into the shell's
    // stdin after creation — that way ctrl-c drops back to the shell prompt
    // instead of killing the node.
    let shell = shell_path();
    let harness_cmd = harness
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let display_command = harness_cmd.map_or_else(|| shell.clone(), str::to_owned);

    // Swarm-aware harness launches force adoption: pre-create an instance
    // row, inject `SWARM_MCP_INSTANCE_ID` into the shell env, and bind the
    // PTY immediately. The auto-typed harness command inherits the env from
    // the shell, so the swarm-mcp subprocess it spawns will adopt the row
    // on `register` instead of creating a duplicate. Plain shells (no
    // harness) stay identity-less.
    let mut env = HashMap::new();
    let instance_id = if let Some(harness_name) = harness_cmd {
        let token = launch_token();
        let label = build_label(
            Some(harness_name),
            &token,
            &format!("provider:{harness_name}"),
            None,
        );

        let conn = writes::open_rw().map_err(AppError::Operation)?;
        writes::ensure_adopted_column(&conn).map_err(AppError::Operation)?;
        let pending = writes::create_pending_instance(
            &conn,
            &cwd,
            None,
            Some(&label),
            None,
        )
        .map_err(AppError::Operation)?;
        drop(conn);

        env.insert("SWARM_MCP_INSTANCE_ID".to_owned(), pending.id.clone());
        env.insert("SWARM_MCP_SCOPE".to_owned(), pending.scope.clone());
        env.insert("SWARM_MCP_LABEL".to_owned(), label);
        env.insert("SWARM_UI_LAUNCH_TOKEN".to_owned(), token);
        env.insert("SWARM_UI_ROLE".to_owned(), harness_name.to_owned());
        Some(pending.id)
    } else {
        None
    };

    let pty_id = match pty_manager.create_session(
        &app_handle,
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_label_includes_role_and_token() {
        let label = build_label(Some("planner"), "abc", "provider:oc", None);
        assert!(label.contains("role:planner"));
        assert!(label.contains("launch:abc"));
        assert!(label.contains("provider:oc"));
    }

    #[test]
    fn build_label_deduplicates_tokens() {
        let label = build_label(
            Some("planner"),
            "abc",
            "provider:oc",
            Some("provider:oc extra:tag"),
        );
        // "provider:oc" should appear only once
        assert_eq!(
            label.matches("provider:oc").count(),
            1
        );
        assert!(label.contains("extra:tag"));
    }

    #[test]
    fn build_label_without_role() {
        let label = build_label(None, "abc", "provider:oc", None);
        assert!(!label.contains("role:"));
        assert!(label.contains("launch:abc"));
    }

    #[test]
    fn binary_basename_extracts_name() {
        assert_eq!(binary_basename("/usr/local/bin/opencode"), "opencode");
        assert_eq!(binary_basename("claude"), "claude");
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
    fn render_command_without_args() {
        assert_eq!(render_command("opencode", &[]), "opencode");
    }

    #[test]
    fn render_command_with_args() {
        assert_eq!(
            render_command("git", &["status".into(), "-s".into()]),
            "git status -s"
        );
    }
}

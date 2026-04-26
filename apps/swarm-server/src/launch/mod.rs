use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::PathBuf;

use dirs::config_dir;
use serde::Deserialize;
use swarm_protocol::rpc::SpawnPtyRequest;

use crate::error::ServerError;

const DEFAULT_ROLES: &[&str] = &["planner", "implementer", "reviewer", "researcher"];
const HARNESSES: &[&str] = &["shell", "claude", "codex", "opencode"];
const DEFAULT_PATH_SEGMENTS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];
const SERVER_CONFIG_DIR: &str = "swarm-server";
const LEGACY_UI_CONFIG_DIR: &str = "swarm-ui";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchConfig {
    roles: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: HashMap<String, String>,
    pub display_command: String,
    pub bootstrap_command: Option<String>,
    pub role: Option<String>,
    pub scope: Option<String>,
    pub label: Option<String>,
    pub name: Option<String>,
    pub initial_input: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LaunchConfigFile {
    roles: Option<Vec<String>>,
}

impl LaunchConfig {
    #[must_use]
    pub fn load() -> Self {
        let mut seen = HashSet::new();
        let mut roles = Vec::new();

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

    fn is_known(&self, role: &str) -> bool {
        self.roles.iter().any(|known| known == role)
    }
}

impl Default for LaunchConfig {
    fn default() -> Self {
        Self::load()
    }
}

pub fn build_launch_plan(
    request: &SpawnPtyRequest,
    launch_config: &LaunchConfig,
) -> Result<LaunchPlan, ServerError> {
    validate_working_dir(&request.cwd)?;

    let harness = validate_harness_name(&request.harness)?;
    let role = validate_role(request.role.as_deref(), launch_config)?;
    let name = validate_name(request.name.as_deref())?;

    let shell = shell_path();
    let mut env = HashMap::new();
    env.insert("TERM".to_owned(), "xterm-256color".to_owned());
    env.insert("PATH".to_owned(), merged_path());

    for (key, value) in &request.env {
        if let Some((key, value)) = normalize_env_pair(key, value)? {
            env.insert(key, value);
        }
    }

    if let Some(scope) = request
        .scope
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        env.insert("SWARM_MCP_SCOPE".to_owned(), scope.to_owned());
    }
    if let Some(label) = request
        .label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        env.insert("SWARM_MCP_LABEL".to_owned(), label.to_owned());
    }
    if let Some(instance_id) = request
        .instance_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        env.insert("SWARM_MCP_INSTANCE_ID".to_owned(), instance_id.to_owned());
        env.insert("SWARM_MCP_DIRECTORY".to_owned(), request.cwd.clone());
        env.insert("SWARM_MCP_FILE_ROOT".to_owned(), request.cwd.clone());
    }

    let direct_harness = harness != "shell"
        && (!request.args.is_empty()
            || request
                .initial_input
                .as_deref()
                .is_some_and(|value| !value.is_empty()));

    let (command, args, display_command, bootstrap_command) = if harness == "shell" {
        (shell.clone(), request.args.clone(), shell, None)
    } else if direct_harness {
        env.insert("SWARM_SERVER_HARNESS".to_owned(), harness.to_owned());
        env.insert(
            "SWARM_UI_ROLE".to_owned(),
            role.clone().unwrap_or_else(|| harness.to_owned()),
        );
        (
            harness.to_owned(),
            request.args.clone(),
            harness.to_owned(),
            None,
        )
    } else {
        env.insert("SWARM_SERVER_HARNESS".to_owned(), harness.to_owned());
        env.insert(
            "SWARM_UI_ROLE".to_owned(),
            role.clone().unwrap_or_else(|| harness.to_owned()),
        );
        (
            shell.clone(),
            Vec::new(),
            harness.to_owned(),
            Some(harness.to_owned()),
        )
    };

    Ok(LaunchPlan {
        command,
        args,
        cwd: request.cwd.clone(),
        env,
        display_command,
        bootstrap_command,
        role,
        scope: request.scope.clone(),
        label: request.label.clone(),
        name,
        initial_input: request.initial_input.clone(),
    })
}

fn normalize_env_pair(key: &str, value: &str) -> Result<Option<(String, String)>, ServerError> {
    let key = key.trim();
    if key.is_empty() {
        return Ok(None);
    }

    if key.contains('=') || key.contains('\0') || value.contains('\0') {
        return Err(ServerError::validation(format!(
            "invalid environment override: {key}"
        )));
    }

    if !key.chars().all(|c| c == '_' || c.is_ascii_alphanumeric())
        || key.chars().next().is_some_and(|c| c.is_ascii_digit())
    {
        return Err(ServerError::validation(format!(
            "invalid environment override: {key}"
        )));
    }

    Ok(Some((key.to_owned(), value.to_owned())))
}

fn read_launch_config_file() -> Option<LaunchConfigFile> {
    candidate_config_paths().into_iter().find_map(|path| {
        let contents = fs::read_to_string(path).ok()?;
        serde_json::from_str(&contents).ok()
    })
}

fn candidate_config_paths() -> Vec<PathBuf> {
    let Some(base) = config_dir() else {
        return Vec::new();
    };

    vec![
        base.join(SERVER_CONFIG_DIR).join("role-presets.json"),
        base.join(LEGACY_UI_CONFIG_DIR).join("role-presets.json"),
    ]
}

fn shell_path() -> String {
    env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned())
}

fn merged_path() -> String {
    let existing = env::var("PATH").ok();
    let mut seen = HashSet::new();
    let mut ordered = Vec::new();

    if let Some(path) = existing.as_deref() {
        for segment in path.split(':').filter(|segment| !segment.is_empty()) {
            if seen.insert(segment.to_owned()) {
                ordered.push(segment.to_owned());
            }
        }
    }

    for segment in DEFAULT_PATH_SEGMENTS {
        if seen.insert((*segment).to_owned()) {
            ordered.push((*segment).to_owned());
        }
    }

    ordered.join(":")
}

fn validate_harness_name(harness: &str) -> Result<&str, ServerError> {
    let trimmed = harness.trim();
    if HARNESSES.contains(&trimmed) {
        Ok(trimmed)
    } else {
        Err(ServerError::validation(format!(
            "unsupported harness: {harness}"
        )))
    }
}

fn validate_role(
    role: Option<&str>,
    launch_config: &LaunchConfig,
) -> Result<Option<String>, ServerError> {
    let Some(role) = role.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    if launch_config.is_known(role) {
        Ok(Some(role.to_owned()))
    } else {
        Err(ServerError::validation(format!("unknown role: {role}")))
    }
}

fn validate_name(name: Option<&str>) -> Result<Option<String>, ServerError> {
    let Some(name) = name.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    if name.len() > 32 {
        return Err(ServerError::validation(
            "name must be 32 characters or fewer",
        ));
    }

    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(ServerError::validation(
            "name may only contain letters, digits, dashes, dots, and underscores",
        ));
    }

    Ok(Some(name.to_owned()))
}

fn validate_working_dir(dir: &str) -> Result<(), ServerError> {
    if dir.is_empty() {
        return Err(ServerError::validation(
            "working directory must not be empty",
        ));
    }
    let path = std::path::Path::new(dir);
    if !path.is_absolute() {
        return Err(ServerError::validation(
            "working directory must be an absolute path",
        ));
    }
    if !path.is_dir() {
        return Err(ServerError::validation(format!(
            "working directory does not exist: {dir}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use swarm_protocol::{PROTOCOL_VERSION, rpc::SpawnPtyRequest};

    fn request(harness: &str) -> SpawnPtyRequest {
        SpawnPtyRequest {
            v: PROTOCOL_VERSION,
            cwd: std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            harness: harness.to_owned(),
            role: Some("planner".to_owned()),
            scope: Some("swarm-mcp".to_owned()),
            label: Some("provider:codex".to_owned()),
            name: Some("scout".to_owned()),
            instance_id: None,
            cols: None,
            rows: None,
            args: Vec::new(),
            env: Default::default(),
            initial_input: None,
        }
    }

    #[test]
    fn launch_plan_for_shell_uses_shell_directly() {
        let plan = build_launch_plan(&request("shell"), &LaunchConfig::load()).unwrap();
        assert!(plan.bootstrap_command.is_none());
        assert_eq!(plan.command, plan.display_command);
        assert_eq!(
            plan.env.get("TERM").map(String::as_str),
            Some("xterm-256color")
        );
    }

    #[test]
    fn launch_plan_for_harness_bootstraps_inside_shell() {
        let plan = build_launch_plan(&request("codex"), &LaunchConfig::load()).unwrap();
        assert_eq!(plan.display_command, "codex");
        assert_eq!(plan.bootstrap_command.as_deref(), Some("codex"));
        assert_eq!(plan.command, shell_path());
        assert!(plan.args.is_empty());
        assert_eq!(
            plan.env.get("SWARM_SERVER_HARNESS").map(String::as_str),
            Some("codex")
        );
    }

    #[test]
    fn launch_plan_for_harness_args_runs_harness_directly() {
        let mut request = request("codex");
        request.args = vec!["exec".to_owned(), "fix it".to_owned()];
        request
            .env
            .insert("SWARM_DB_PATH".to_owned(), "/tmp/swarm.db".to_owned());

        let plan = build_launch_plan(&request, &LaunchConfig::load()).unwrap();

        assert_eq!(plan.command, "codex");
        assert_eq!(plan.args, vec!["exec".to_owned(), "fix it".to_owned()]);
        assert!(plan.bootstrap_command.is_none());
        assert_eq!(
            plan.env.get("SWARM_DB_PATH").map(String::as_str),
            Some("/tmp/swarm.db")
        );
    }

    #[test]
    fn launch_plan_injects_preassigned_instance_env() {
        let mut request = request("claude");
        request.instance_id = Some("inst-123".to_owned());

        let plan = build_launch_plan(&request, &LaunchConfig::load()).unwrap();

        assert_eq!(
            plan.env.get("SWARM_MCP_INSTANCE_ID").map(String::as_str),
            Some("inst-123")
        );
        assert_eq!(
            plan.env.get("SWARM_MCP_DIRECTORY").map(String::as_str),
            Some(request.cwd.as_str())
        );
        assert_eq!(
            plan.env.get("SWARM_MCP_FILE_ROOT").map(String::as_str),
            Some(request.cwd.as_str())
        );
    }

    #[test]
    fn validate_name_rejects_unsafe_characters() {
        assert!(validate_name(Some("hello world")).is_err());
        assert!(validate_name(Some("name:thing")).is_err());
    }

    #[test]
    fn merged_path_includes_standard_locations() {
        let merged = merged_path();
        assert!(merged.contains("/usr/bin"));
        assert!(merged.contains("/bin"));
    }
}

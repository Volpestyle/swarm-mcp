use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
pub use swarm_protocol::state::{INSTANCE_OFFLINE_AFTER_SECS, INSTANCE_STALE_AFTER_SECS};
pub use swarm_protocol::{
    Annotation, Event, Instance, InstanceStatus, KvEntry, Lease, Lock, Message, Task, TaskStatus,
    TaskType,
};

// ---------------------------------------------------------------------------
// AppError — typed error for Tauri IPC commands
// ---------------------------------------------------------------------------

/// Structured error type for all Tauri commands.
///
/// The custom [`Serialize`] implementation ensures that only user-safe messages
/// cross the IPC boundary.  [`Internal`](AppError::Internal) details are logged
/// to stderr but the frontend only ever sees `"internal error"`.
#[derive(Debug)]
pub enum AppError {
    /// Input validation failures — safe to expose.
    Validation(String),
    /// Resource not found — safe to expose.
    NotFound(String),
    /// Operational errors (PTY I/O, process spawn, etc.) — safe to expose in a
    /// developer tool.
    Operation(String),
    /// Internal errors (lock poisoning, unexpected state) — detail is hidden
    /// from the frontend.
    Internal(String),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Validation(msg) | Self::NotFound(msg) | Self::Operation(msg) => {
                write!(f, "{msg}")
            }
            Self::Internal(_) => write!(f, "internal error"),
        }
    }
}

impl std::error::Error for AppError {}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        if let Self::Internal(detail) = self {
            eprintln!("[error] {detail}");
        }
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PtySession {
    pub id: String,
    pub command: String,
    pub cwd: String,
    pub started_at: i64,
    pub exit_code: Option<i32>,
    pub bound_instance_id: Option<String>,
    pub launch_token: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub lease: Option<Lease>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SavedLayout {
    #[serde(default)]
    pub nodes: HashMap<String, GraphPosition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SwarmUpdate {
    #[serde(default)]
    pub instances: Vec<Instance>,
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub messages: Vec<Message>,
    #[serde(default)]
    pub locks: Vec<Lock>,
    /// All `context` rows including locks. The frontend groups by `type` to
    /// surface findings/warnings/bugs/notes/todos alongside locks.
    #[serde(default)]
    pub annotations: Vec<Annotation>,
    #[serde(default)]
    pub kv: Vec<KvEntry>,
    /// Last N events from the audit log — seeds the Activity timeline on
    /// cold start. Live updates arrive via the `swarm:events:new` delta
    /// event so we don't reship the entire ring buffer every poll.
    #[serde(default)]
    pub events: Vec<Event>,
    pub ui_meta: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBoundary {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn default_project_color() -> String {
    "#ffffff".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSpace {
    pub id: String,
    pub name: String,
    pub root: String,
    #[serde(default = "default_project_color")]
    pub color: String,
    pub additional_roots: Vec<String>,
    pub notes: String,
    pub scope: Option<String>,
    pub boundary: ProjectBoundary,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMembership {
    pub project_id: String,
    pub instance_id: String,
    pub attached_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAsset {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub title: String,
    pub path: Option<String>,
    pub content: Option<String>,
    pub description: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssetAttachment {
    pub asset_id: String,
    pub target_type: String,
    pub target_id: String,
    pub attached_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserContext {
    pub scope: String,
    pub id: String,
    pub owner_instance_id: Option<String>,
    pub endpoint: String,
    pub host: String,
    pub port: i64,
    pub profile_dir: String,
    pub pid: Option<i64>,
    pub start_url: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub scope: String,
    pub context_id: String,
    pub tab_id: String,
    pub tab_type: String,
    pub url: String,
    pub title: String,
    pub active: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshotElement {
    pub tag: String,
    pub role: Option<String>,
    pub text: String,
    pub selector: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshot {
    pub id: String,
    pub scope: String,
    pub context_id: String,
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub text: String,
    pub elements: Vec<BrowserSnapshotElement>,
    pub screenshot_path: Option<String>,
    pub created_by: Option<String>,
    pub created_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_online_within_threshold() {
        let now = 1_000;
        assert_eq!(
            InstanceStatus::from_heartbeat(now, now),
            InstanceStatus::Online
        );
        assert_eq!(
            InstanceStatus::from_heartbeat(now, now - INSTANCE_STALE_AFTER_SECS),
            InstanceStatus::Online
        );
    }

    #[test]
    fn instance_stale_after_threshold() {
        let now = 1_000;
        assert_eq!(
            InstanceStatus::from_heartbeat(now, now - INSTANCE_STALE_AFTER_SECS - 1),
            InstanceStatus::Stale
        );
    }

    #[test]
    fn instance_offline_after_threshold() {
        let now = 1_000;
        assert_eq!(
            InstanceStatus::from_heartbeat(now, now - INSTANCE_OFFLINE_AFTER_SECS - 1),
            InstanceStatus::Offline
        );
    }

    #[test]
    fn instance_status_boundary_stale_to_offline() {
        let now = 1_000;
        // Exactly at the offline boundary should still be stale
        assert_eq!(
            InstanceStatus::from_heartbeat(now, now - INSTANCE_OFFLINE_AFTER_SECS),
            InstanceStatus::Stale
        );
    }

    #[test]
    fn app_error_internal_hides_detail() {
        let err = AppError::Internal("secret db path /home/user/.swarm".into());
        assert_eq!(err.to_string(), "internal error");
    }

    #[test]
    fn app_error_validation_exposes_message() {
        let err = AppError::Validation("cwd must not be empty".into());
        assert_eq!(err.to_string(), "cwd must not be empty");
    }

    #[test]
    fn app_error_not_found_exposes_message() {
        let err = AppError::NotFound("unknown PTY session: abc".into());
        assert_eq!(err.to_string(), "unknown PTY session: abc");
    }

    #[test]
    fn app_error_operation_exposes_message() {
        let err = AppError::Operation("failed to open PTY".into());
        assert_eq!(err.to_string(), "failed to open PTY");
    }
}

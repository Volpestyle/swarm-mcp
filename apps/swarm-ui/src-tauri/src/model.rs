use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

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

pub const INSTANCE_STALE_AFTER_SECS: i64 = 30;
pub const INSTANCE_OFFLINE_AFTER_SECS: i64 = 60;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum InstanceStatus {
    Online,
    Stale,
    Offline,
}

impl InstanceStatus {
    #[must_use]
    pub fn from_heartbeat(now: i64, heartbeat: i64) -> Self {
        let age = now.saturating_sub(heartbeat);
        if age <= INSTANCE_STALE_AFTER_SECS {
            Self::Online
        } else if age <= INSTANCE_OFFLINE_AFTER_SECS {
            Self::Stale
        } else {
            Self::Offline
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Open,
    Claimed,
    InProgress,
    Done,
    Failed,
    Cancelled,
    Blocked,
    ApprovalRequired,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    Review,
    Implement,
    Fix,
    Test,
    Research,
    Other,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum NodeType {
    Instance,
    Pty,
    Bound,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EdgeType {
    Message,
    Task,
    Dependency,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Instance {
    pub id: String,
    pub scope: String,
    pub directory: String,
    pub root: String,
    pub file_root: String,
    pub pid: i64,
    pub label: Option<String>,
    pub registered_at: i64,
    pub heartbeat: i64,
    pub status: InstanceStatus,
    /// `true` once the child process inside the PTY has called
    /// `swarm.register` and taken over the instance row. `false` while the row
    /// is still a UI-owned placeholder waiting for adoption.
    #[serde(default = "default_adopted")]
    pub adopted: bool,
}

#[allow(clippy::missing_const_for_fn)]
fn default_adopted() -> bool {
    // Rows created by the MCP register path before adoption existed are
    // treated as adopted; only UI pre-created rows have adopted=0.
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Task {
    pub id: String,
    pub scope: String,
    #[serde(rename = "type")]
    pub type_: TaskType,
    pub title: String,
    pub description: Option<String>,
    pub requester: String,
    pub assignee: Option<String>,
    pub status: TaskStatus,
    #[serde(default)]
    pub files: Vec<String>,
    pub result: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub changed_at: i64,
    pub priority: i64,
    #[serde(default)]
    pub depends_on: Vec<String>,
    pub parent_task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Message {
    pub id: i64,
    pub scope: String,
    pub sender: String,
    pub recipient: Option<String>,
    pub content: String,
    pub created_at: i64,
    pub read: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Lock {
    pub scope: String,
    pub file: String,
    pub instance_id: String,
}

/// One row from the `context` table — file-scoped notes agents leave for one
/// another. Includes locks (`type = 'lock'`) plus findings, warnings, bugs,
/// notes, and todos. The `Lock` shape above is kept as a thin derived view
/// for code that only needs the lock-specific fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Annotation {
    pub id: String,
    pub scope: String,
    pub instance_id: String,
    pub file: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub content: String,
    pub created_at: i64,
}

/// One row from the `events` audit log. Powers the Activity timeline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Event {
    pub id: i64,
    pub scope: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub actor: Option<String>,
    pub subject: Option<String>,
    /// Raw JSON string from the DB. The frontend parses on demand.
    pub payload: Option<String>,
    pub created_at: i64,
}

/// A single non-`ui/*` row from the `kv` table — coordination state agents
/// write to share scope-level data (turn counters, status flags, queues...).
/// `value` is the raw stored string; the frontend pretty-prints if JSON.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KvEntry {
    pub scope: String,
    pub key: String,
    pub value: String,
    pub updated_at: i64,
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
}

#[allow(dead_code)]
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

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    pub instance: Option<Instance>,
    pub pty_session: Option<PtySession>,
    pub position: Option<GraphPosition>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphEdge {
    pub id: String,
    #[serde(rename = "type")]
    pub edge_type: EdgeType,
    pub source: String,
    pub target: String,
    pub metadata: Option<Value>,
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

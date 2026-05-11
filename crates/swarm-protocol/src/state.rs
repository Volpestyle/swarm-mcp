//! Authoritative state types read from `swarm.db` and exposed to clients.
//!
//! Most of these mirror rows in `swarm.db` exactly, with the renderer-specific
//! or Tauri-specific fields removed. The Swift client mirrors every struct in
//! this file.
//!
//! Timestamps are Unix seconds as `i64` to match the existing on-disk schema.
//! Row ids from append-only tables are `i64`; ids from content-addressed
//! tables are `String`.

use serde::{Deserialize, Serialize};

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
    #[serde(default = "default_adopted")]
    pub adopted: bool,
}

#[allow(clippy::missing_const_for_fn)]
fn default_adopted() -> bool {
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
    pub review_of_task_id: Option<String>,
    pub fixes_task_id: Option<String>,
    pub progress_summary: Option<String>,
    pub progress_updated_at: Option<i64>,
    pub blocked_reason: Option<String>,
    pub expected_next_update_at: Option<i64>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Event {
    pub id: i64,
    pub scope: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub actor: Option<String>,
    pub subject: Option<String>,
    /// Raw JSON string as stored in `swarm.db`. Clients parse on demand.
    pub payload: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KvEntry {
    pub scope: String,
    pub key: String,
    pub value: String,
    pub updated_at: i64,
}

/// A PTY session owned by swarm-server. Exposed so clients can list attachable
/// sessions; stream bytes via `Frame::PtyData`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PtyInfo {
    pub id: String,
    pub command: String,
    pub cwd: String,
    pub started_at: i64,
    pub exit_code: Option<i32>,
    pub bound_instance_id: Option<String>,
    /// Geometry the owner has requested. View-follow clients letterbox.
    pub cols: u16,
    pub rows: u16,
    /// Current lease holder, if any.
    pub lease: Option<Lease>,
}

/// Interactive-owner lease for a PTY. Exactly one holder at a time controls
/// input and geometry; everyone else is read-only view-follow.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Lease {
    /// Stable identifier of the lease holder. For the local UI this is
    /// `"local:swarm-ui"`; for paired mobile devices it is `device:<id>`.
    pub holder: String,
    pub acquired_at: i64,
    /// Monotonic generation number; bumps on takeover. Clients use this to
    /// dedupe late lease events after reconnect.
    pub generation: u64,
}

/// Full read-only snapshot of swarm state at one instant.
///
/// Returned by `GET /state` as the initial hydration body; delta updates
/// arrive via `Frame::DeltaTable`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SwarmSnapshot {
    #[serde(default)]
    pub instances: Vec<Instance>,
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub messages: Vec<Message>,
    #[serde(default)]
    pub locks: Vec<Lock>,
    #[serde(default)]
    pub kv: Vec<KvEntry>,
    #[serde(default)]
    pub events: Vec<Event>,
    #[serde(default)]
    pub ptys: Vec<PtyInfo>,
    /// Cursors describing the snapshot's point-in-time; clients pass these
    /// back on WS connect to resume from the correct delta offset.
    pub cursors: crate::cursors::TableCursors,
    /// Server-side wall clock when the snapshot was assembled. Lets clients
    /// derive `InstanceStatus` consistently even if their local clock drifts.
    pub server_time: i64,
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
}

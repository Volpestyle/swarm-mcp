pub const SWARM_UPDATE: &str = "swarm:update";
/// Delta event carrying only messages newly appended since the last emit.
/// Used by the frontend's packet animation so every row renders as a single
/// visual event instead of re-walking the full last-100 snapshot each tick.
pub const MESSAGES_APPENDED: &str = "swarm:messages:new";
/// Delta event carrying only audit-log rows newly inserted since the last
/// emit. Powers the Activity timeline panel and graph-level signals
/// (lock badges, edge flashes) without re-shipping the full event window.
pub const EVENTS_APPENDED: &str = "swarm:events:new";
pub const PTY_CREATED: &str = "pty:created";
pub const PTY_CLOSED: &str = "pty:closed";
pub const BIND_RESOLVED: &str = "bind:resolved";
#[allow(dead_code)]
pub const BIND_UNRESOLVED: &str = "bind:unresolved";

/// Emitted when a PTY bound to a swarm instance ends (child exit or manual
/// close). Payload: `{ pty_id, instance_id }`. The main.rs listener uses this
/// to delete any unadopted placeholder row and drop the binder mapping so
/// stale state doesn't leak into subsequent launches.
pub const PTY_BOUND_EXIT: &str = "pty:bound_exit";

/// Shared prefix for per-session PTY events (`pty://{id}/data`, `pty://{id}/exit`).
const PTY_EVENT_PREFIX: &str = "pty://";

pub fn pty_data_event(id: &str) -> String {
    format!("{PTY_EVENT_PREFIX}{id}/data")
}

pub fn pty_exit_event(id: &str) -> String {
    format!("{PTY_EVENT_PREFIX}{id}/exit")
}

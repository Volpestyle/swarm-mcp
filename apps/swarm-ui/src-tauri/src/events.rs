pub const SWARM_UPDATE: &str = "swarm:update";
pub const PTY_CREATED: &str = "pty:created";
pub const PTY_CLOSED: &str = "pty:closed";
pub const BIND_RESOLVED: &str = "bind:resolved";
pub const BIND_UNRESOLVED: &str = "bind:unresolved";

/// Shared prefix for per-session PTY events (`pty://{id}/data`, `pty://{id}/exit`).
const PTY_EVENT_PREFIX: &str = "pty://";

pub fn pty_data_event(id: &str) -> String {
    format!("{PTY_EVENT_PREFIX}{id}/data")
}

pub fn pty_exit_event(id: &str) -> String {
    format!("{PTY_EVENT_PREFIX}{id}/exit")
}

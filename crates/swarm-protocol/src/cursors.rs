//! Replay cursors for the two independent replay domains.
//!
//! Table deltas and PTY streams deliberately do not share a `since` type:
//! they have different retention policies, different row identifiers, and
//! different semantics (table deltas are rows; PTY frames are bytes).
//!
//! ## Cursor precision
//!
//! Append-only tables (`messages`, `events`) use their monotonic row id as
//! an opaque cursor. Two inserts are guaranteed unique by the database.
//!
//! Mutable tables use a [`ChangeCursor`] tuple `(at, id)`. Second-resolution
//! timestamps alone are unsafe for strict-greater comparison because two
//! writes can share the same second; pairing with a per-row identifier
//! breaks the tie. Server-side queries should use:
//!
//! ```sql
//! WHERE (changed_at, id) > (?, ?) ORDER BY changed_at, id
//! ```

use serde::{Deserialize, Serialize};

/// Tuple cursor for mutable tables. Compared lexicographically: `(at, id)`
/// strictly greater than the client's stored tuple. Ties within a single
/// second are resolved by the row's stable identifier.
///
/// The concrete meaning of `at` and `id` is decided by the server per table;
/// clients treat it as an opaque token and hand it back on reconnect.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ChangeCursor {
    /// Unix seconds of the last observed mutation for this table.
    pub at: i64,
    /// Tiebreaker within the same `at` — a stable per-row identifier
    /// (typically the primary key or a composite key stringified).
    pub id: String,
}

impl ChangeCursor {
    #[must_use]
    pub fn new(at: i64, id: impl Into<String>) -> Self {
        Self { at, id: id.into() }
    }
}

/// Per-table replay cursors. Clients pass whichever cursors they have on
/// reconnect; missing fields request a full replay for that table.
///
/// Append-only tables use `i64` row ids. Mutable tables use [`ChangeCursor`].
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TableCursors {
    /// Max `messages.id` already seen. Append-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub messages: Option<i64>,
    /// Max `events.id` already seen. Append-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<i64>,
    /// Last observed tuple for the `instances` table (any field change,
    /// including heartbeat, label, adopted, deregistration).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instances: Option<ChangeCursor>,
    /// Last observed tuple for the `tasks` table.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tasks: Option<ChangeCursor>,
    /// Last observed tuple for locks (derived from `context` where
    /// `type = 'lock'`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locks: Option<ChangeCursor>,
    /// Last observed tuple for annotations (all `context` rows).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<ChangeCursor>,
    /// Last observed tuple for the `kv` table.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kv: Option<ChangeCursor>,
    /// Last observed tuple for the PTY catalog (server-side; not in swarm.db).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ptys: Option<ChangeCursor>,
}

/// Per-PTY byte stream cursor. Monotonic, bounded by the server-side ring
/// buffer. Gaps are reported as `Frame::PtyAttachRejected` rather than silent
/// data loss.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct PtySeq(pub u64);

impl PtySeq {
    #[must_use]
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    #[must_use]
    pub const fn value(self) -> u64 {
        self.0
    }

    #[must_use]
    pub const fn next(self) -> Self {
        Self(self.0.wrapping_add(1))
    }
}

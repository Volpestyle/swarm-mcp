//! WebSocket frame types.
//!
//! Every frame sent or received on the `/stream` WSS carries a `Frame`
//! envelope:
//!
//! ```text
//! { "v": 1, "type": "pty.data", "pty_id": "abc", "seq": 42, "data": <bytes> }
//! ```
//!
//! Frames are tagged by the `type` discriminator.
//!
//! ## Forward compatibility
//!
//! Both [`FramePayload`] and [`DeltaTableFrame`] include an `Unknown`
//! variant via `#[serde(other)]`. Any `type` / `table` tag a consumer does
//! not recognise decodes as `Unknown` — clients should skip these and
//! continue processing rather than treat them as a fatal error. This is how
//! the protocol evolves forward-compatibly: a v2 daemon can introduce new
//! frames and a v1 client silently ignores them.
//!
//! Note that `Unknown` loses the original payload; use the audit log or
//! version negotiation if you need to recover dropped data.
//!
//! ## Directionality
//!
//! - Server → Client: `DeltaTable`, `PtyData`, `PtyExit`, `LeaseChanged`,
//!   `EventAppended`, `PtyAttachRejected`, `Pong`, `Error`
//! - Client → Server: `PtyAttach`, `PtyDetach`, `PtyInput`, `PtyResize`,
//!   `Subscribe`, `Ping`
//!
//! Both directions share the same envelope; servers and clients ignore
//! frames they shouldn't have received.
//!
//! ## Deltas carry upserts *and* removes
//!
//! Mutable-table deltas include a `removes` list so clients learn about
//! deregistrations, unlocks, KV deletions, PTY closures, etc. without having
//! to mirror the audit log. Append-only tables (`messages`) only have
//! `upserts`.

use serde::{Deserialize, Serialize};

use crate::cursors::{ChangeCursor, PtySeq, TableCursors};
use crate::errors::ErrorPayload;
use crate::state::{Event, Instance, KvEntry, Lease, Lock, Message, PtyInfo, Task};

/// Envelope for every WebSocket frame.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Frame {
    /// Protocol version. Required on every frame — never inferred.
    pub v: u32,
    #[serde(flatten)]
    pub payload: FramePayload,
}

impl Frame {
    #[must_use]
    pub fn new(payload: FramePayload) -> Self {
        Self {
            v: crate::version::PROTOCOL_VERSION,
            payload,
        }
    }
}

/// Tagged union of all frame bodies. The `type` field is the discriminator.
///
/// Unknown `type` values deserialize as [`FramePayload::Unknown`]; consumers
/// should skip rather than error.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FramePayload {
    // ---- Server → Client ------------------------------------------------
    /// Incremental upserts and removes for a single table.
    #[serde(rename = "delta.table")]
    DeltaTable(DeltaTableFrame),

    /// Append-only audit event. At-least-once delivery; dedupe by `event.id`.
    #[serde(rename = "event.appended")]
    EventAppended(EventAppendedFrame),

    /// Raw bytes from a PTY's stdout/stderr. Monotonic per `pty_id`.
    #[serde(rename = "pty.data")]
    PtyData(PtyDataFrame),

    /// PTY child process has exited.
    #[serde(rename = "pty.exit")]
    PtyExit(PtyExitFrame),

    /// Lease for a PTY changed hands. Clients should update their
    /// "interactive / view-follow" indicator.
    #[serde(rename = "lease.changed")]
    LeaseChanged(LeaseChangedFrame),

    /// Client's requested replay cursor was outside the retained window
    /// and data cannot be recovered. Client should refetch a full snapshot.
    #[serde(rename = "pty.attach_rejected")]
    PtyAttachRejected(PtyAttachRejectedFrame),

    /// Fatal error on the stream; the connection will close after this.
    #[serde(rename = "error")]
    Error(ErrorPayload),

    /// Keepalive response.
    #[serde(rename = "pong")]
    Pong(PongFrame),

    // ---- Client → Server ------------------------------------------------
    /// Subscribe to a PTY's byte stream. Optional `since_seq` requests
    /// replay from the given cursor.
    #[serde(rename = "pty.attach")]
    PtyAttach(PtyAttachFrame),

    /// Unsubscribe from a PTY's byte stream.
    #[serde(rename = "pty.detach")]
    PtyDetach(PtyDetachFrame),

    /// Write bytes directly to a PTY over the bidirectional stream.
    #[serde(rename = "pty.input")]
    PtyInput(PtyInputFrame),

    /// Resize a PTY over the bidirectional stream.
    #[serde(rename = "pty.resize")]
    PtyResize(PtyResizeFrame),

    /// Client is ready to receive deltas for the given scope and cursors.
    #[serde(rename = "subscribe")]
    Subscribe(SubscribeFrame),

    /// Keepalive.
    #[serde(rename = "ping")]
    Ping(PingFrame),

    // ---- Forward compatibility -----------------------------------------
    /// Unknown `type` tag — decoded but not understood by this build.
    /// Consumers must skip rather than error.
    #[serde(other)]
    Unknown,
}

// ---- Delta table frame ----------------------------------------------------

/// One variant per mutable table. Each variant carries a `cursor` (or
/// `watermark` for append-only tables), a list of upserted rows, and a list
/// of removed keys.
///
/// `Kv` and `Locks` have composite primary keys and use dedicated key
/// structs. Everything else keys off the row's stable `id` as a String.
///
/// Unknown `table` values decode as [`DeltaTableFrame::Unknown`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "table", rename_all = "snake_case")]
pub enum DeltaTableFrame {
    Instances {
        cursor: ChangeCursor,
        #[serde(default)]
        upserts: Vec<Instance>,
        #[serde(default)]
        removes: Vec<String>,
    },
    Tasks {
        cursor: ChangeCursor,
        #[serde(default)]
        upserts: Vec<Task>,
        #[serde(default)]
        removes: Vec<String>,
    },
    Messages {
        /// Append-only; watermark is max `messages.id` in this batch.
        watermark: i64,
        #[serde(default)]
        upserts: Vec<Message>,
    },
    Locks {
        cursor: ChangeCursor,
        #[serde(default)]
        upserts: Vec<Lock>,
        #[serde(default)]
        removes: Vec<LockKey>,
    },
    Kv {
        cursor: ChangeCursor,
        #[serde(default)]
        upserts: Vec<KvEntry>,
        #[serde(default)]
        removes: Vec<KvKey>,
    },
    /// Server-side PTY catalog deltas. Not backed by swarm.db.
    Ptys {
        cursor: ChangeCursor,
        #[serde(default)]
        upserts: Vec<PtyInfo>,
        #[serde(default)]
        removes: Vec<String>,
    },
    /// Unknown `table` tag — forward-compat skip.
    #[serde(other)]
    Unknown,
}

/// Composite key for a `locks` row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct LockKey {
    pub scope: String,
    pub file: String,
}

/// Composite key for a `kv` row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct KvKey {
    pub scope: String,
    pub key: String,
}

// ---- Concrete frame payloads ---------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EventAppendedFrame {
    pub watermark: i64,
    pub event: Event,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PtyDataFrame {
    pub pty_id: String,
    pub seq: PtySeq,
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PtyExitFrame {
    pub pty_id: String,
    pub exit_code: Option<i32>,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LeaseChangedFrame {
    pub pty_id: String,
    pub lease: Option<Lease>,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PtyAttachRejectedFrame {
    pub pty_id: String,
    /// The earliest seq still retained. Client can reattach at this point
    /// and accept a byte-stream gap.
    pub earliest_seq: PtySeq,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PongFrame {
    pub echo: u64,
    pub server_time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PtyAttachFrame {
    pub pty_id: String,
    #[serde(default)]
    pub since_seq: Option<PtySeq>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PtyDetachFrame {
    pub pty_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PtyInputFrame {
    pub pty_id: String,
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PtyResizeFrame {
    pub pty_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubscribeFrame {
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub cursors: TableCursors,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PingFrame {
    pub echo: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unknown_frame_type_decodes_as_unknown() {
        // A v2 daemon introduces a new frame type; a v1 client must not
        // hard-fail.
        let wire = json!({
            "v": 1,
            "type": "some.future_frame",
            "payload": {"whatever": 1},
        });
        let frame: Frame = serde_json::from_value(wire).expect("must not fail");
        assert_eq!(frame.v, 1);
        assert_eq!(frame.payload, FramePayload::Unknown);
    }

    #[test]
    fn unknown_delta_table_decodes_as_unknown() {
        let wire = json!({
            "v": 1,
            "type": "delta.table",
            "table": "future_table",
            "cursor": { "at": 1, "id": "x" },
        });
        let frame: Frame = serde_json::from_value(wire).expect("must not fail");
        match frame.payload {
            FramePayload::DeltaTable(DeltaTableFrame::Unknown) => {}
            other => panic!("expected DeltaTableFrame::Unknown, got {other:?}"),
        }
    }

    #[test]
    fn missing_v_field_is_rejected() {
        let wire = json!({
            "type": "ping",
            "echo": 1,
        });
        let result: Result<Frame, _> = serde_json::from_value(wire);
        assert!(result.is_err(), "missing v must not silently default");
    }
}

//! Generates golden JSON + msgpack fixtures for every public protocol type.
//!
//! Run with: `cargo run --bin generate-fixtures` from the crate directory.
//! Regenerate after any protocol change. Commit the fixtures/ output.
//!
//! The Swift side reads these same files and round-trips them through its
//! own type mirrors; any drift between Rust and Swift fails CI.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use swarm_protocol::frames::{
    DeltaTableFrame, EventAppendedFrame, KvKey, LeaseChangedFrame, LockKey, PingFrame, PongFrame,
    PtyAttachFrame, PtyAttachRejectedFrame, PtyDataFrame, PtyDetachFrame, PtyExitFrame,
    SubscribeFrame,
};
use swarm_protocol::rpc::{
    Ack, ClosePtyRequest, LeaseResponse, PairRequest, PairResponse, ReleaseLeaseRequest,
    RequestLeaseRequest, ResizePtyRequest, RevealRequest, RevealResponse, RevokeRequest,
    RevokeResponse, SpawnPtyRequest, SpawnPtyResponse, WritePtyRequest,
};
use swarm_protocol::{
    Annotation, ChangeCursor, ErrorClass, ErrorPayload, Event, Frame, FramePayload, Instance,
    InstanceStatus, KvEntry, Lease, Lock, Message, PROTOCOL_VERSION, PtyInfo, PtySeq,
    SwarmSnapshot, TableCursors, Task, TaskStatus, TaskType,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures");
    fs::create_dir_all(&out_dir)?;

    // Clear prior fixtures so stale files don't linger.
    for entry in fs::read_dir(&out_dir)? {
        let entry = entry?;
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) == Some("json")
            || p.extension().and_then(|s| s.to_str()) == Some("msgpack")
        {
            fs::remove_file(p)?;
        }
    }

    write(&out_dir, "instance", &sample_instance())?;
    write(&out_dir, "task", &sample_task())?;
    write(&out_dir, "message", &sample_message())?;
    write(&out_dir, "lock", &sample_lock())?;
    write(&out_dir, "annotation", &sample_annotation())?;
    write(&out_dir, "event", &sample_event())?;
    write(&out_dir, "kv_entry", &sample_kv_entry())?;
    write(&out_dir, "pty_info", &sample_pty_info())?;
    write(&out_dir, "lease", &sample_lease())?;
    write(&out_dir, "table_cursors", &sample_table_cursors())?;
    write(&out_dir, "swarm_snapshot", &sample_swarm_snapshot())?;

    // RPC
    write(&out_dir, "rpc_pair_request", &sample_pair_request())?;
    write(&out_dir, "rpc_pair_response", &sample_pair_response())?;
    write(&out_dir, "rpc_revoke_request", &sample_revoke_request())?;
    write(&out_dir, "rpc_revoke_response", &sample_revoke_response())?;
    write(
        &out_dir,
        "rpc_spawn_pty_request",
        &sample_spawn_pty_request(),
    )?;
    write(
        &out_dir,
        "rpc_spawn_pty_response",
        &sample_spawn_pty_response(),
    )?;
    write(
        &out_dir,
        "rpc_write_pty_request",
        &sample_write_pty_request(),
    )?;
    write(
        &out_dir,
        "rpc_resize_pty_request",
        &sample_resize_pty_request(),
    )?;
    write(
        &out_dir,
        "rpc_close_pty_request",
        &sample_close_pty_request(),
    )?;
    write(
        &out_dir,
        "rpc_request_lease_request",
        &sample_request_lease_request(),
    )?;
    write(
        &out_dir,
        "rpc_release_lease_request",
        &sample_release_lease_request(),
    )?;
    write(&out_dir, "rpc_lease_response", &sample_lease_response())?;
    write(&out_dir, "rpc_reveal_request", &sample_reveal_request())?;
    write(&out_dir, "rpc_reveal_response", &sample_reveal_response())?;
    write(&out_dir, "rpc_ack", &Ack::ok())?;

    // Errors
    write(
        &out_dir,
        "error_auth",
        &ErrorPayload::new(ErrorClass::Auth, "token revoked"),
    )?;
    write(
        &out_dir,
        "error_rate_limited",
        &ErrorPayload::new(ErrorClass::RateLimited, "too many requests").with_retry_after(30),
    )?;
    write(
        &out_dir,
        "error_lease_conflict",
        &ErrorPayload::new(ErrorClass::LeaseConflict, "another device holds the lease"),
    )?;

    // Frames — one fixture per frame variant
    write(&out_dir, "frame_delta_messages", &frame_delta_messages())?;
    write(&out_dir, "frame_delta_tasks", &frame_delta_tasks())?;
    write(&out_dir, "frame_delta_locks", &frame_delta_locks())?;
    write(&out_dir, "frame_delta_kv", &frame_delta_kv())?;
    write(&out_dir, "frame_delta_ptys", &frame_delta_ptys())?;
    write(&out_dir, "frame_event_appended", &frame_event_appended())?;
    write(&out_dir, "frame_pty_data", &frame_pty_data())?;
    write(&out_dir, "frame_pty_exit", &frame_pty_exit())?;
    write(&out_dir, "frame_lease_changed", &frame_lease_changed())?;
    write(
        &out_dir,
        "frame_pty_attach_rejected",
        &frame_pty_attach_rejected(),
    )?;
    write(&out_dir, "frame_error", &frame_error())?;
    write(&out_dir, "frame_pong", &frame_pong())?;
    write(&out_dir, "frame_pty_attach", &frame_pty_attach())?;
    write(&out_dir, "frame_pty_detach", &frame_pty_detach())?;
    write(&out_dir, "frame_subscribe", &frame_subscribe())?;
    write(&out_dir, "frame_ping", &frame_ping())?;

    // Manifest so Swift can enumerate without hardcoding the list.
    let mut names: Vec<String> = fs::read_dir(&out_dir)?
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| {
            Path::new(n)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
                && n != "manifest.json"
        })
        .map(|n| n.trim_end_matches(".json").to_string())
        .collect();
    names.sort();
    let manifest = serde_json::json!({
        "protocol_version": PROTOCOL_VERSION,
        "fixtures": names,
    });
    fs::write(
        out_dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;

    println!(
        "wrote {} fixtures to {}",
        fs::read_dir(&out_dir)?.count(),
        out_dir.display()
    );
    Ok(())
}

fn write<T>(dir: &Path, name: &str, value: &T) -> Result<(), Box<dyn std::error::Error>>
where
    T: Serialize,
{
    let json = serde_json::to_vec_pretty(value)?;
    fs::write(dir.join(format!("{name}.json")), json)?;

    let msgpack = rmp_serde::to_vec_named(value)?;
    fs::write(dir.join(format!("{name}.msgpack")), msgpack)?;
    Ok(())
}

// ---- Samples -------------------------------------------------------------

fn sample_instance() -> Instance {
    Instance {
        id: "inst-abc-123".into(),
        scope: "swarm-mcp".into(),
        directory: "/Users/james/code/swarm-mcp".into(),
        root: "/Users/james/code/swarm-mcp".into(),
        file_root: "/Users/james/code/swarm-mcp".into(),
        pid: 54321,
        label: Some("planner".into()),
        registered_at: 1_745_000_000,
        heartbeat: 1_745_000_020,
        status: InstanceStatus::Online,
        adopted: true,
    }
}

fn sample_task() -> Task {
    Task {
        id: "task-7".into(),
        scope: "swarm-mcp".into(),
        type_: TaskType::Implement,
        title: "Add swarm-server pairing endpoint".into(),
        description: Some("HTTPS POST /pair, validates code, issues token.".into()),
        requester: "inst-coordinator-1".into(),
        assignee: Some("inst-abc-123".into()),
        status: TaskStatus::InProgress,
        files: vec!["apps/swarm-server/src/pair.rs".into()],
        result: None,
        created_at: 1_745_000_000,
        updated_at: 1_745_000_120,
        changed_at: 1_745_000_120,
        priority: 5,
        depends_on: vec!["task-6".into()],
        parent_task_id: None,
    }
}

fn sample_message() -> Message {
    Message {
        id: 42,
        scope: "swarm-mcp".into(),
        sender: "inst-abc-123".into(),
        recipient: Some("inst-coordinator-1".into()),
        content: "Finished pairing handler, ready for review".into(),
        created_at: 1_745_000_150,
        read: false,
    }
}

fn sample_lock() -> Lock {
    Lock {
        scope: "swarm-mcp".into(),
        file: "apps/swarm-server/src/pair.rs".into(),
        instance_id: "inst-abc-123".into(),
    }
}

fn sample_annotation() -> Annotation {
    Annotation {
        id: "note-12".into(),
        scope: "swarm-mcp".into(),
        instance_id: "inst-abc-123".into(),
        file: "apps/swarm-server/src/pair.rs".into(),
        type_: "finding".into(),
        content: "Token entropy should come from OsRng, not rand::thread_rng.".into(),
        created_at: 1_745_000_200,
    }
}

fn sample_event() -> Event {
    Event {
        id: 891,
        scope: "swarm-mcp".into(),
        type_: "task.claimed".into(),
        actor: Some("inst-abc-123".into()),
        subject: Some("task-7".into()),
        payload: Some(r#"{"previous_assignee":null}"#.into()),
        created_at: 1_745_000_120,
    }
}

fn sample_kv_entry() -> KvEntry {
    KvEntry {
        scope: "swarm-mcp".into(),
        key: "review/next_turn".into(),
        value: "inst-coordinator-1".into(),
        updated_at: 1_745_000_050,
    }
}

fn sample_pty_info() -> PtyInfo {
    PtyInfo {
        id: "pty-9f3a".into(),
        command: "claude".into(),
        cwd: "/Users/james/code/swarm-mcp".into(),
        started_at: 1_745_000_010,
        exit_code: None,
        bound_instance_id: Some("inst-abc-123".into()),
        cols: 120,
        rows: 40,
        lease: Some(sample_lease()),
    }
}

fn sample_lease() -> Lease {
    Lease {
        holder: "local:swarm-ui".into(),
        acquired_at: 1_745_000_015,
        generation: 3,
    }
}

fn sample_table_cursors() -> TableCursors {
    TableCursors {
        messages: Some(42),
        events: Some(891),
        instances: Some(ChangeCursor::new(1_745_000_020, "inst-abc-123")),
        tasks: Some(ChangeCursor::new(1_745_000_120, "task-7")),
        locks: Some(ChangeCursor::new(
            1_745_000_200,
            "swarm-mcp\u{1f}apps/swarm-server/src/pair.rs",
        )),
        annotations: Some(ChangeCursor::new(1_745_000_200, "note-12")),
        kv: Some(ChangeCursor::new(
            1_745_000_050,
            "swarm-mcp\u{1f}review/next_turn",
        )),
        ptys: Some(ChangeCursor::new(1_745_000_010, "pty-9f3a")),
    }
}

fn sample_swarm_snapshot() -> SwarmSnapshot {
    SwarmSnapshot {
        instances: vec![sample_instance()],
        tasks: vec![sample_task()],
        messages: vec![sample_message()],
        locks: vec![sample_lock()],
        annotations: vec![sample_annotation()],
        kv: vec![sample_kv_entry()],
        events: vec![sample_event()],
        ptys: vec![sample_pty_info()],
        cursors: sample_table_cursors(),
        server_time: 1_745_000_300,
    }
}

// ---- RPC samples ---------------------------------------------------------

fn sample_pair_request() -> PairRequest {
    PairRequest {
        v: PROTOCOL_VERSION,
        code: "482913".into(),
        device_name: "James's iPhone".into(),
        device_id: "vendor-1D2E3F-4A5B".into(),
        platform: Some("iphone".into()),
        pairing_secret: "pair-secret".into(),
        client_nonce: "d9f8d28d4bb541b2a1cf5a7a8170a611".into(),
    }
}

fn sample_pair_response() -> PairResponse {
    PairResponse {
        v: PROTOCOL_VERSION,
        token: "tok_01HF8Z9KQ3N4M5P6R7S8T9V0W1".into(),
        cert_fingerprint: "sha256:89AB4E2C7F9D1E3B6A8C0D2E4F5A7B9C1D3E5F7A9B1C3D5E7F9A1B3C5D7E9F0A"
            .into(),
        device_id: "dev-01HF8Z9KQ3".into(),
        scopes: vec!["swarm-mcp".into()],
    }
}

fn sample_revoke_request() -> RevokeRequest {
    RevokeRequest {
        v: PROTOCOL_VERSION,
        device_id: "dev-01HF8Z9KQ3".into(),
    }
}

fn sample_revoke_response() -> RevokeResponse {
    RevokeResponse {
        v: PROTOCOL_VERSION,
        revoked: true,
    }
}

fn sample_spawn_pty_request() -> SpawnPtyRequest {
    SpawnPtyRequest {
        v: PROTOCOL_VERSION,
        cwd: "/Users/james/code/swarm-mcp".into(),
        harness: "claude".into(),
        role: Some("reviewer".into()),
        scope: Some("swarm-mcp".into()),
        label: None,
        name: Some("reviewer-2".into()),
        instance_id: None,
        cols: Some(120),
        rows: Some(40),
    }
}

fn sample_spawn_pty_response() -> SpawnPtyResponse {
    SpawnPtyResponse {
        v: PROTOCOL_VERSION,
        pty: sample_pty_info(),
    }
}

fn sample_write_pty_request() -> WritePtyRequest {
    WritePtyRequest {
        v: PROTOCOL_VERSION,
        pty_id: "pty-9f3a".into(),
        data: b"review the pairing handler\n".to_vec(),
    }
}

fn sample_resize_pty_request() -> ResizePtyRequest {
    ResizePtyRequest {
        v: PROTOCOL_VERSION,
        pty_id: "pty-9f3a".into(),
        cols: 80,
        rows: 24,
    }
}

fn sample_close_pty_request() -> ClosePtyRequest {
    ClosePtyRequest {
        v: PROTOCOL_VERSION,
        pty_id: "pty-9f3a".into(),
        force: false,
    }
}

fn sample_request_lease_request() -> RequestLeaseRequest {
    RequestLeaseRequest {
        v: PROTOCOL_VERSION,
        pty_id: "pty-9f3a".into(),
        takeover: true,
    }
}

fn sample_release_lease_request() -> ReleaseLeaseRequest {
    ReleaseLeaseRequest {
        v: PROTOCOL_VERSION,
        pty_id: "pty-9f3a".into(),
    }
}

fn sample_lease_response() -> LeaseResponse {
    LeaseResponse {
        v: PROTOCOL_VERSION,
        pty_id: "pty-9f3a".into(),
        lease: sample_lease(),
    }
}

fn sample_reveal_request() -> RevealRequest {
    RevealRequest {
        v: PROTOCOL_VERSION,
        subject: "kv:swarm-mcp:api_token".into(),
    }
}

fn sample_reveal_response() -> RevealResponse {
    RevealResponse {
        v: PROTOCOL_VERSION,
        value: "ghp_redactedInRealPayloadsObviously".into(),
    }
}

// ---- Frame samples -------------------------------------------------------

fn frame_delta_messages() -> Frame {
    Frame::new(FramePayload::DeltaTable(DeltaTableFrame::Messages {
        watermark: 43,
        upserts: vec![sample_message()],
    }))
}

fn frame_delta_tasks() -> Frame {
    Frame::new(FramePayload::DeltaTable(DeltaTableFrame::Tasks {
        cursor: ChangeCursor::new(1_745_000_120, "task-7"),
        upserts: vec![sample_task()],
        removes: vec!["task-6".into()],
    }))
}

fn frame_delta_locks() -> Frame {
    Frame::new(FramePayload::DeltaTable(DeltaTableFrame::Locks {
        cursor: ChangeCursor::new(
            1_745_000_200,
            "swarm-mcp\u{1f}apps/swarm-server/src/pair.rs",
        ),
        upserts: vec![sample_lock()],
        removes: vec![LockKey {
            scope: "swarm-mcp".into(),
            file: "apps/swarm-server/src/bind.rs".into(),
        }],
    }))
}

fn frame_delta_kv() -> Frame {
    Frame::new(FramePayload::DeltaTable(DeltaTableFrame::Kv {
        cursor: ChangeCursor::new(1_745_000_050, "swarm-mcp\u{1f}review/next_turn"),
        upserts: vec![sample_kv_entry()],
        removes: vec![KvKey {
            scope: "swarm-mcp".into(),
            key: "review/prev_turn".into(),
        }],
    }))
}

fn frame_delta_ptys() -> Frame {
    Frame::new(FramePayload::DeltaTable(DeltaTableFrame::Ptys {
        cursor: ChangeCursor::new(1_745_000_010, "pty-9f3a"),
        upserts: vec![sample_pty_info()],
        removes: vec!["pty-deadbeef".into()],
    }))
}

fn frame_event_appended() -> Frame {
    Frame::new(FramePayload::EventAppended(EventAppendedFrame {
        watermark: 892,
        event: sample_event(),
    }))
}

fn frame_pty_data() -> Frame {
    Frame::new(FramePayload::PtyData(PtyDataFrame {
        pty_id: "pty-9f3a".into(),
        seq: PtySeq::new(1024),
        data: b"\x1b[2Kwelcome to claude\n".to_vec(),
    }))
}

fn frame_pty_exit() -> Frame {
    Frame::new(FramePayload::PtyExit(PtyExitFrame {
        pty_id: "pty-9f3a".into(),
        exit_code: Some(0),
        at: 1_745_001_000,
    }))
}

fn frame_lease_changed() -> Frame {
    Frame::new(FramePayload::LeaseChanged(LeaseChangedFrame {
        pty_id: "pty-9f3a".into(),
        lease: Some(Lease {
            holder: "device:dev-01HF8Z9KQ3".into(),
            acquired_at: 1_745_000_500,
            generation: 4,
        }),
        at: 1_745_000_500,
    }))
}

fn frame_pty_attach_rejected() -> Frame {
    Frame::new(FramePayload::PtyAttachRejected(PtyAttachRejectedFrame {
        pty_id: "pty-9f3a".into(),
        earliest_seq: PtySeq::new(2048),
        reason: "requested seq is older than ring buffer retention".into(),
    }))
}

fn frame_error() -> Frame {
    Frame::new(FramePayload::Error(
        ErrorPayload::new(ErrorClass::VersionMismatch, "client too old").with_request_id("req-abc"),
    ))
}

fn frame_pong() -> Frame {
    Frame::new(FramePayload::Pong(PongFrame {
        echo: 7,
        server_time: 1_745_000_600,
    }))
}

fn frame_pty_attach() -> Frame {
    Frame::new(FramePayload::PtyAttach(PtyAttachFrame {
        pty_id: "pty-9f3a".into(),
        since_seq: Some(PtySeq::new(1024)),
    }))
}

fn frame_pty_detach() -> Frame {
    Frame::new(FramePayload::PtyDetach(PtyDetachFrame {
        pty_id: "pty-9f3a".into(),
    }))
}

fn frame_subscribe() -> Frame {
    Frame::new(FramePayload::Subscribe(SubscribeFrame {
        scope: Some("swarm-mcp".into()),
        cursors: sample_table_cursors(),
    }))
}

fn frame_ping() -> Frame {
    Frame::new(FramePayload::Ping(PingFrame { echo: 7 }))
}

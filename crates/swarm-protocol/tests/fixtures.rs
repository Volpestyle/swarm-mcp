//! Round-trip tests against the checked-in golden fixtures.
//!
//! These tests deliberately couple the Rust types to the files in
//! `fixtures/`. If you break compatibility, either regenerate the fixtures
//! (`cargo run --bin generate-fixtures`) and commit the diff, or revert the
//! type change — never edit the fixtures by hand.
//!
//! The Swift client mirrors these tests on its side, reading the same files
//! and verifying equivalent round-trips. That's the cross-language contract.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use serde::de::DeserializeOwned;
use swarm_protocol::rpc::{
    Ack, ClosePtyRequest, LeaseResponse, PairRequest, PairResponse, ReleaseLeaseRequest,
    RequestLeaseRequest, ResizePtyRequest, RevealRequest, RevealResponse, RevokeRequest,
    RevokeResponse, SpawnPtyRequest, SpawnPtyResponse, WritePtyRequest,
};
use swarm_protocol::{
    ErrorPayload, Event, Frame, Instance, KvEntry, Lease, Lock, Message, PtyInfo, SwarmSnapshot,
    TableCursors, Task,
};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

fn round_trip<T>(name: &str)
where
    T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let dir = fixtures_dir();

    let json_path = dir.join(format!("{name}.json"));
    let msgpack_path = dir.join(format!("{name}.msgpack"));

    let json_bytes = fs::read(&json_path)
        .unwrap_or_else(|e| panic!("missing fixture {}: {e}", json_path.display()));
    let msgpack_bytes = fs::read(&msgpack_path)
        .unwrap_or_else(|e| panic!("missing fixture {}: {e}", msgpack_path.display()));

    let from_json: T = serde_json::from_slice(&json_bytes)
        .unwrap_or_else(|e| panic!("JSON decode failed for {name}: {e}"));
    let from_msgpack: T = rmp_serde::from_slice(&msgpack_bytes)
        .unwrap_or_else(|e| panic!("msgpack decode failed for {name}: {e}"));

    assert_eq!(
        from_json, from_msgpack,
        "JSON and msgpack decodings disagree for {name}",
    );

    // Round-trip through JSON and msgpack; confirms deterministic encoding
    // for the current set of representable values.
    let json_reencoded = serde_json::to_vec_pretty(&from_json)
        .unwrap_or_else(|e| panic!("JSON encode failed for {name}: {e}"));
    let msgpack_reencoded = rmp_serde::to_vec_named(&from_msgpack)
        .unwrap_or_else(|e| panic!("msgpack encode failed for {name}: {e}"));

    assert_eq!(
        json_bytes, json_reencoded,
        "JSON fixture is not byte-stable for {name} — regenerate fixtures",
    );
    assert_eq!(
        msgpack_bytes, msgpack_reencoded,
        "msgpack fixture is not byte-stable for {name} — regenerate fixtures",
    );
}

#[test]
fn state_instance() {
    round_trip::<Instance>("instance");
}

#[test]
fn state_task() {
    round_trip::<Task>("task");
}

#[test]
fn state_message() {
    round_trip::<Message>("message");
}

#[test]
fn state_lock() {
    round_trip::<Lock>("lock");
}

#[test]
fn state_event() {
    round_trip::<Event>("event");
}

#[test]
fn state_kv_entry() {
    round_trip::<KvEntry>("kv_entry");
}

#[test]
fn state_pty_info() {
    round_trip::<PtyInfo>("pty_info");
}

#[test]
fn state_lease() {
    round_trip::<Lease>("lease");
}

#[test]
fn state_table_cursors() {
    round_trip::<TableCursors>("table_cursors");
}

#[test]
fn state_swarm_snapshot() {
    round_trip::<SwarmSnapshot>("swarm_snapshot");
}

#[test]
fn rpc_pair_request() {
    round_trip::<PairRequest>("rpc_pair_request");
}

#[test]
fn rpc_pair_response() {
    round_trip::<PairResponse>("rpc_pair_response");
}

#[test]
fn rpc_revoke_request() {
    round_trip::<RevokeRequest>("rpc_revoke_request");
}

#[test]
fn rpc_revoke_response() {
    round_trip::<RevokeResponse>("rpc_revoke_response");
}

#[test]
fn rpc_spawn_pty_request() {
    round_trip::<SpawnPtyRequest>("rpc_spawn_pty_request");
}

#[test]
fn rpc_spawn_pty_response() {
    round_trip::<SpawnPtyResponse>("rpc_spawn_pty_response");
}

#[test]
fn rpc_write_pty_request() {
    round_trip::<WritePtyRequest>("rpc_write_pty_request");
}

#[test]
fn rpc_resize_pty_request() {
    round_trip::<ResizePtyRequest>("rpc_resize_pty_request");
}

#[test]
fn rpc_close_pty_request() {
    round_trip::<ClosePtyRequest>("rpc_close_pty_request");
}

#[test]
fn rpc_request_lease_request() {
    round_trip::<RequestLeaseRequest>("rpc_request_lease_request");
}

#[test]
fn rpc_release_lease_request() {
    round_trip::<ReleaseLeaseRequest>("rpc_release_lease_request");
}

#[test]
fn rpc_lease_response() {
    round_trip::<LeaseResponse>("rpc_lease_response");
}

#[test]
fn rpc_reveal_request() {
    round_trip::<RevealRequest>("rpc_reveal_request");
}

#[test]
fn rpc_reveal_response() {
    round_trip::<RevealResponse>("rpc_reveal_response");
}

#[test]
fn rpc_ack() {
    round_trip::<Ack>("rpc_ack");
}

#[test]
fn error_auth() {
    round_trip::<ErrorPayload>("error_auth");
}

#[test]
fn error_rate_limited() {
    round_trip::<ErrorPayload>("error_rate_limited");
}

#[test]
fn error_lease_conflict() {
    round_trip::<ErrorPayload>("error_lease_conflict");
}

#[test]
fn frame_delta_messages() {
    round_trip::<Frame>("frame_delta_messages");
}

#[test]
fn frame_delta_tasks() {
    round_trip::<Frame>("frame_delta_tasks");
}

#[test]
fn frame_delta_locks() {
    round_trip::<Frame>("frame_delta_locks");
}

#[test]
fn frame_delta_kv() {
    round_trip::<Frame>("frame_delta_kv");
}

#[test]
fn frame_delta_ptys() {
    round_trip::<Frame>("frame_delta_ptys");
}

#[test]
fn frame_event_appended() {
    round_trip::<Frame>("frame_event_appended");
}

#[test]
fn frame_pty_data() {
    round_trip::<Frame>("frame_pty_data");
}

#[test]
fn frame_pty_exit() {
    round_trip::<Frame>("frame_pty_exit");
}

#[test]
fn frame_lease_changed() {
    round_trip::<Frame>("frame_lease_changed");
}

#[test]
fn frame_pty_attach_rejected() {
    round_trip::<Frame>("frame_pty_attach_rejected");
}

#[test]
fn frame_error() {
    round_trip::<Frame>("frame_error");
}

#[test]
fn frame_pong() {
    round_trip::<Frame>("frame_pong");
}

#[test]
fn frame_pty_attach() {
    round_trip::<Frame>("frame_pty_attach");
}

#[test]
fn frame_pty_detach() {
    round_trip::<Frame>("frame_pty_detach");
}

#[test]
fn frame_subscribe() {
    round_trip::<Frame>("frame_subscribe");
}

#[test]
fn frame_ping() {
    round_trip::<Frame>("frame_ping");
}

#[test]
fn manifest_enumerates_all_fixtures() {
    let manifest_path = fixtures_dir().join("manifest.json");
    let bytes = fs::read(&manifest_path).expect("manifest.json missing — run generate-fixtures");
    let manifest: serde_json::Value =
        serde_json::from_slice(&bytes).expect("manifest.json is not valid JSON");
    let fixtures = manifest["fixtures"]
        .as_array()
        .expect("manifest.fixtures must be an array");
    assert!(
        !fixtures.is_empty(),
        "manifest must list at least one fixture"
    );

    // Every listed fixture must exist as both .json and .msgpack.
    for f in fixtures {
        let name = f.as_str().expect("fixture entries must be strings");
        assert!(
            fixtures_dir().join(format!("{name}.json")).exists(),
            "missing {name}.json"
        );
        assert!(
            fixtures_dir().join(format!("{name}.msgpack")).exists(),
            "missing {name}.msgpack"
        );
    }
}

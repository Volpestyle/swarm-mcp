//! Request/response types for HTTPS + UDS RPC endpoints.
//!
//! Route conventions (informative; not encoded in these types):
//!
//! - `POST   /pair`                  → `PairRequest`  → `PairResponse`
//! - `POST   /auth/revoke`           → `RevokeRequest` → `RevokeResponse`
//! - `GET    /auth/devices`          →                 → `DevicesResponse`
//! - `POST   /auth/pairing-session`  → `CreatePairingSessionRequest`
//!   → `CreatePairingSessionResponse`
//! - `DELETE /auth/pairing-session/{id}`
//!   →                 → `CancelPairingSessionResponse`
//! - `GET    /state?cursors=…`       →                 → `state::SwarmSnapshot`
//! - `POST   /pty`                   → `SpawnPtyRequest` → `SpawnPtyResponse`
//! - `POST   /pty/{id}/input`        → `WritePtyRequest` → `Ack`
//! - `POST   /pty/{id}/resize`       → `ResizePtyRequest` → `Ack`
//! - `DELETE /pty/{id}`              → `ClosePtyRequest` → `Ack`
//! - `POST   /pty/{id}/lease`        → `RequestLeaseRequest` → `LeaseResponse`
//! - `DELETE /pty/{id}/lease`        → `ReleaseLeaseRequest` → `Ack`
//! - `POST   /reveal`                → `RevealRequest`  → `RevealResponse`
//!
//! Every request and response body carries `v` as a required field. A
//! missing `v` is a decode error, not a silent default — this keeps
//! envelope-level compatibility checks honest and distinguishes "old client"
//! from "client forgot the field."

use serde::{Deserialize, Serialize};

use crate::state::PtyInfo;
use crate::version::PROTOCOL_VERSION;

// ---- Pairing --------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PairRequest {
    pub v: u32,
    /// 6-digit code displayed in swarm-ui Mobile Access at the moment of pairing.
    pub code: String,
    /// Operator-chosen device name (e.g. "James's iPhone"). Shown in the
    /// paired-devices list; does not affect auth.
    pub device_name: String,
    /// Opaque device-stable identifier. For iOS, this is the app's
    /// `identifierForVendor`. Servers treat it as a bag-of-bits.
    pub device_id: String,
    /// Hardware family hint for display only ("iphone", "ipad", "mac", ...).
    #[serde(default)]
    pub platform: Option<String>,
    /// One-shot pairing secret carried alongside the short code in the QR or
    /// manual payload. Prevents code-only redemption during the TTL window.
    pub pairing_secret: String,
    /// Client-generated one-shot nonce for this pairing attempt. The server
    /// binds the redeemed code to this handshake material before minting a
    /// long-lived token.
    pub client_nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PairResponse {
    pub v: u32,
    /// Long-lived bearer token. iOS stores in Keychain behind biometrics.
    pub token: String,
    /// Hex-encoded SHA-256 of the server's TLS cert. Client pins this going
    /// forward; a change means the server was re-provisioned and pairing
    /// must be repeated.
    pub cert_fingerprint: String,
    /// Server-assigned device id (may differ from the client-supplied one
    /// if the server chose to re-key). Used on subsequent requests.
    pub device_id: String,
    /// Server-side scopes the device is allowed to observe.
    #[serde(default)]
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RevokeRequest {
    pub v: u32,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RevokeResponse {
    pub v: u32,
    pub revoked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceInfo {
    pub device_id: String,
    pub device_name: String,
    #[serde(default)]
    pub platform: Option<String>,
    pub created_at: i64,
    pub last_seen_at: i64,
    #[serde(default)]
    pub revoked_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DevicesResponse {
    pub v: u32,
    #[serde(default)]
    pub devices: Vec<DeviceInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreatePairingSessionRequest {
    pub v: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PairingSessionInfo {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub cert_fingerprint: String,
    pub code: String,
    pub pairing_secret: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreatePairingSessionResponse {
    pub v: u32,
    pub session: PairingSessionInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CancelPairingSessionResponse {
    pub v: u32,
    pub canceled: bool,
}

// ---- PTY lifecycle --------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpawnPtyRequest {
    pub v: u32,
    pub cwd: String,
    /// One of: "shell" | "claude" | "codex" | "opencode". Future harnesses
    /// added as opaque strings.
    pub harness: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// Existing swarm instance row to re-adopt. When absent, the server may
    /// create a fresh pending instance row for swarm-aware harnesses.
    #[serde(default)]
    pub instance_id: Option<String>,
    /// Initial geometry. If unset, the server chooses a sensible default
    /// (typically 120x40).
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
    /// Optional CLI arguments for the selected harness. When non-empty for a
    /// non-shell harness, swarm-server runs the harness process directly in the
    /// PTY instead of spawning a shell and waiting for a UI client to type the
    /// harness command.
    #[serde(default)]
    pub args: Vec<String>,
    /// Additional environment variables for the spawned PTY child. Authoritative
    /// SWARM_MCP_* identity values may be overwritten by the server after these
    /// are merged.
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    /// Optional bytes, encoded as UTF-8 text, to write to PTY stdin immediately
    /// after the child process is spawned.
    #[serde(default)]
    pub initial_input: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpawnPtyResponse {
    pub v: u32,
    pub pty: PtyInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WritePtyRequest {
    pub v: u32,
    pub pty_id: String,
    /// Raw bytes to write to the PTY's stdin. Serializes as an array of
    /// integers in JSON and as native bytes in msgpack.
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResizePtyRequest {
    pub v: u32,
    pub pty_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClosePtyRequest {
    pub v: u32,
    pub pty_id: String,
    /// If true, send SIGKILL after a grace period; otherwise SIGTERM only.
    #[serde(default)]
    pub force: bool,
}

// ---- Lease ---------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RequestLeaseRequest {
    pub v: u32,
    pub pty_id: String,
    /// If true, force takeover from the current holder after the grace
    /// window. Writes an audit event attributed to the requesting device.
    #[serde(default)]
    pub takeover: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LeaseResponse {
    pub v: u32,
    pub pty_id: String,
    pub lease: crate::state::Lease,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReleaseLeaseRequest {
    pub v: u32,
    pub pty_id: String,
}

// ---- Redaction reveal ----------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RevealRequest {
    pub v: u32,
    /// Subject identifier the client is revealing — `kv:<scope>:<key>` or
    /// `message:<id>`. The server interprets.
    pub subject: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RevealResponse {
    pub v: u32,
    /// Unredacted value. The server writes an audit event for this reveal
    /// before returning.
    pub value: String,
}

// ---- Generic ack ---------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Ack {
    pub v: u32,
    pub ok: bool,
    /// Echo back a server-assigned request id for logging.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

impl Ack {
    #[must_use]
    pub fn ok() -> Self {
        Self {
            v: PROTOCOL_VERSION,
            ok: true,
            request_id: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_v_is_rejected() {
        let wire = json!({
            "code": "482913",
            "device_name": "phone",
            "device_id": "abc",
            "pairing_secret": "pair-secret",
            "client_nonce": "client-nonce",
        });
        let result: Result<PairRequest, _> = serde_json::from_value(wire);
        assert!(result.is_err());
    }

    #[test]
    fn present_v_is_accepted() {
        let wire = json!({
            "v": 1,
            "code": "482913",
            "device_name": "phone",
            "device_id": "abc",
            "pairing_secret": "pair-secret",
            "client_nonce": "client-nonce",
        });
        let req: PairRequest = serde_json::from_value(wire).unwrap();
        assert_eq!(req.v, 1);
    }
}

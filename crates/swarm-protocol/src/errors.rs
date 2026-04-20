//! Error payloads returned over RPC and streamed frames.
//!
//! Every client-visible error carries a machine-readable `class` that
//! parsers can match on, plus a human-readable `message` suitable for
//! operator-facing UI. Internal error detail never crosses this boundary.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ErrorClass {
    /// Request lacked valid auth, token is revoked, or pairing failed.
    Auth,
    /// Rate limit exceeded; clients should back off per `retry_after`.
    RateLimited,
    /// Target object (instance, pty, task) does not exist or is not visible
    /// to this device's scope.
    NotFound,
    /// Lease request conflicted with another holder; takeover required.
    LeaseConflict,
    /// Response was redacted server-side. Client may request reveal if it
    /// has permission.
    Redacted,
    /// Request body failed validation (missing fields, bad types, etc.).
    Validation,
    /// Endpoint exists in the protocol but is not yet implemented by this
    /// build. Clients should treat as transient only if paired with a
    /// version-lower-than-expected hint.
    NotImplemented,
    /// Version mismatch between client and server; one side cannot parse
    /// the other's frames.
    VersionMismatch,
    /// Unrecoverable server-side failure. Detail is intentionally sparse.
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ErrorPayload {
    pub class: ErrorClass,
    pub message: String,
    /// Seconds the client should wait before retrying, if applicable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u32>,
    /// Optional correlation id copied from the triggering request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

impl ErrorPayload {
    #[must_use]
    pub fn new(class: ErrorClass, message: impl Into<String>) -> Self {
        Self {
            class,
            message: message.into(),
            retry_after: None,
            request_id: None,
        }
    }

    #[must_use]
    pub fn with_retry_after(mut self, secs: u32) -> Self {
        self.retry_after = Some(secs);
        self
    }

    #[must_use]
    pub fn with_request_id(mut self, id: impl Into<String>) -> Self {
        self.request_id = Some(id.into());
        self
    }
}

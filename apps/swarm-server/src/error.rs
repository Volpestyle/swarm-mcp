use std::fmt;

use swarm_protocol::{ErrorClass, ErrorPayload, MIN_COMPATIBLE_VERSION, PROTOCOL_VERSION};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerError {
    payload: ErrorPayload,
}

impl ServerError {
    #[must_use]
    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(ErrorClass::Validation, message)
    }

    #[must_use]
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorClass::NotFound, message)
    }

    #[must_use]
    pub fn lease_conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorClass::LeaseConflict, message)
    }

    #[must_use]
    pub fn not_implemented(message: impl Into<String>) -> Self {
        Self::new(ErrorClass::NotImplemented, message)
    }

    #[must_use]
    pub fn version_mismatch(message: impl Into<String>) -> Self {
        Self::new(ErrorClass::VersionMismatch, message)
    }

    #[must_use]
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorClass::Internal, message)
    }

    #[must_use]
    pub fn payload(&self) -> &ErrorPayload {
        &self.payload
    }

    #[must_use]
    pub fn into_payload(self) -> ErrorPayload {
        self.payload
    }

    #[must_use]
    fn new(class: ErrorClass, message: impl Into<String>) -> Self {
        Self {
            payload: ErrorPayload::new(class, message),
        }
    }
}

impl fmt::Display for ServerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.payload.message.fmt(f)
    }
}

impl std::error::Error for ServerError {}

pub fn validate_protocol_version(version: u32) -> Result<(), ServerError> {
    if (MIN_COMPATIBLE_VERSION..=PROTOCOL_VERSION).contains(&version) {
        Ok(())
    } else {
        Err(ServerError::version_mismatch(format!(
            "protocol version {version} is not supported; server expects {MIN_COMPATIBLE_VERSION}..={PROTOCOL_VERSION}"
        )))
    }
}

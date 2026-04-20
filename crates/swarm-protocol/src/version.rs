/// Current wire protocol version. Bump on any breaking change to the shape
/// of public types, RPC request/response bodies, or frame payloads.
pub const PROTOCOL_VERSION: u32 = 1;

/// Oldest protocol version this build can still decode. Clients that declare
/// a version below this during handshake are rejected.
pub const MIN_COMPATIBLE_VERSION: u32 = 1;

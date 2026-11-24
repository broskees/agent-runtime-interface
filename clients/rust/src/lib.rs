//! `ari-client`: drive an ARI driver over `ari/wire`, newline-delimited JSON-RPC 2.0 on the
//! stdio of an `ari-driver` process (the standalone executable needs no Node).
//!
//! The wire types, one async method per call a host makes (`Client::session_start_turn`, ...)
//! and the `Host` trait with one method per call a driver makes (`host/*`) are generated from
//! ARI's `json-schema/` and `spec/v1/methods.json` into `generated.rs`. This file and `client.rs`
//! hold only the framing: request ids, answering the driver's calls while ours are pending,
//! streams as tokio `Stream`s, and the handshake.
//!
//! Every tagged union (`AriEventBody`, `CallError`, `ContentBlock`, ...) keeps a variant this
//! client does not know, such as an `x:` extension event, as `Unrecognized` with its raw JSON,
//! and every enum keeps an unknown value as `Unrecognized(String)`.

mod client;
mod generated;
mod wire;

pub use client::{protocol, transport, unsupported, validation, Client, MemoryHost, Subscription};
pub use generated::*;

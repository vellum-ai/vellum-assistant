//! Vellum Linux native helper. The Electron main process supervises this
//! binary over newline-delimited JSON-RPC 2.0 frames on stdin and stdout.

pub mod modules;
pub mod rpc;

use serde_json::{json, Value};

use crate::register_module;
use crate::rpc::error::RpcResult;
use crate::rpc::router::RpcModule;

/// Liveness probe. Matches the macOS helper's `"pong"` reply.
#[derive(Default)]
pub struct PingModule;

impl RpcModule for PingModule {
    fn methods(&self) -> &[&'static str] {
        &["ping"]
    }

    fn call(&self, _method: &str, _params: Option<Value>) -> RpcResult {
        Ok(json!("pong"))
    }
}

register_module!(PingModule);

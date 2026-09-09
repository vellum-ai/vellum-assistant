//! Module registration and JSON-RPC dispatch. Modules submit themselves
//! through `inventory`, so adding one never touches `main.rs` or this file.

use std::collections::HashMap;

use serde_json::Value;

use crate::rpc::codec::{self, Request};
use crate::rpc::error::{RpcError, RpcResult, METHOD_NOT_FOUND};

pub trait RpcModule: Send + Sync {
    /// Every method name this module answers. Names are globally unique.
    fn methods(&self) -> &[&'static str];

    fn call(&self, method: &str, params: Option<Value>) -> RpcResult;
}

pub struct ModuleRegistration {
    pub build: fn() -> Box<dyn RpcModule>,
}

inventory::collect!(ModuleRegistration);

/// Registers a `Default` module type with the router.
#[macro_export]
macro_rules! register_module {
    ($module:ty) => {
        inventory::submit! {
            $crate::rpc::router::ModuleRegistration {
                build: || Box::new(<$module>::default()),
            }
        }
    };
}

#[derive(Default)]
pub struct Router {
    modules: Vec<Box<dyn RpcModule>>,
    by_method: HashMap<&'static str, usize>,
}

impl Router {
    pub fn from_inventory() -> Result<Self, String> {
        let mut router = Self::default();
        for registration in inventory::iter::<ModuleRegistration> {
            let module = (registration.build)();
            let index = router.modules.len();
            for method in module.methods() {
                if router.by_method.insert(method, index).is_some() {
                    return Err(format!("duplicate RPC method: {method}"));
                }
            }
            router.modules.push(module);
        }
        Ok(router)
    }

    pub fn methods(&self) -> Vec<&'static str> {
        let mut methods: Vec<&'static str> = self.by_method.keys().copied().collect();
        methods.sort_unstable();
        methods
    }

    pub fn dispatch(&self, method: &str, params: Option<Value>) -> RpcResult {
        let index = *self
            .by_method
            .get(method)
            .ok_or_else(|| RpcError::new(METHOD_NOT_FOUND, "Method not found"))?;
        self.modules[index].call(method, params)
    }

    /// Answers one frame. `None` means nothing is written back, which happens
    /// only for notifications (a request without an id).
    pub fn handle_frame(&self, frame: &[u8]) -> Option<String> {
        let Request { id, method, params } = match codec::decode(frame) {
            Ok(request) => request,
            Err((id, error)) => return Some(codec::error_response(id.as_ref(), &error)),
        };
        match (id, self.dispatch(&method, params)) {
            (Some(id), Ok(result)) => Some(codec::success(&id, result)),
            (Some(id), Err(error)) => Some(codec::error_response(Some(&id), &error)),
            (None, Ok(_)) => None,
            (None, Err(error)) => {
                tracing::warn!(method, code = error.code, "notification failed");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn registers_modules_and_dispatches_without_a_dispatcher_edit() {
        let router = Router::from_inventory().expect("registry");
        assert!(router.methods().contains(&"ping"));
        assert!(router.methods().contains(&"capabilities.state"));
        assert_eq!(
            router.handle_frame(br#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#),
            Some(json!({ "jsonrpc": "2.0", "id": 1, "result": "pong" }).to_string())
        );
        let unknown = router
            .handle_frame(br#"{"jsonrpc":"2.0","id":2,"method":"nope"}"#)
            .expect("response");
        assert!(unknown.contains(&METHOD_NOT_FOUND.to_string()));
        // Notifications never get a reply, not even a failure.
        assert_eq!(
            router.handle_frame(br#"{"jsonrpc":"2.0","method":"nope"}"#),
            None
        );
    }
}

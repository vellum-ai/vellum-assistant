/**
 * CES RPC client — assistant-local entry point.
 *
 * Re-exports the shared `@vellumai/ces-client/rpc-client` types and factory
 * so that all assistant-internal consumers (`secure-keys.ts`, `lifecycle.ts`,
 * `server.ts`, etc.) import from this module without a direct package
 * dependency. The process-manager and transport wiring in the assistant
 * remain in the assistant codebase; only the protocol/envelope logic is
 * delegated to the shared package.
 */

export {
  type CesRpcClient as CesClient,
  type CesRpcClientConfig as CesClientConfig,
  CesClientError,
  type CesRpcHandshakeOptions as CesClientHandshakeOptions,
  CesHandshakeError,
  CesRpcError,
  CesTimeoutError,
  type CesTransport,
  CesTransportError,
  createCesRpcClient as createCesClient,
} from "@vellumai/ces-client/rpc-client";

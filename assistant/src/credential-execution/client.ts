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

import {
  type CesRpcClient,
  type CesRpcClientConfig,
  type CesTransport,
  createCesRpcClient,
} from "@vellumai/ces-client/rpc-client";

import { getLogger } from "../util/logger.js";

export {
  type CesRpcClient as CesClient,
  type CesRpcClientConfig as CesClientConfig,
  CesClientError,
  type CesRpcHandshakeOptions as CesClientHandshakeOptions,
  CesHandshakeError,
  type CesTransport,
  CesTransportError,
} from "@vellumai/ces-client/rpc-client";

const log = getLogger("ces-rpc-client");

/**
 * Construct a CES RPC client wired to the assistant logger so handshake-ready
 * and close transitions are visible in the daemon logs.
 */
export function createCesClient(
  transport: CesTransport,
  config?: CesRpcClientConfig,
): CesRpcClient {
  return createCesRpcClient(transport, { logger: log, ...config });
}

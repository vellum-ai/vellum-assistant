/**
 * Map gateway IPC transport failures to route-layer errors.
 *
 * Connect failures (missing or refused `gateway.sock`) are a normal boot-order
 * race, not a process-fatal exception. Surface them as 503 so the assistant
 * stays up and the request degrades.
 */

import {
  IpcCallError,
  IpcConnectError,
} from "@vellumai/gateway-client/ipc-client";

import {
  RouteError,
  ServiceUnavailableError,
} from "../runtime/routes/errors.js";

/**
 * Convert a gateway socket connect failure into a 503 RouteError. Other
 * values pass through unchanged so adapters can share one RouteError branch.
 */
export function mapGatewayIpcConnectError(err: unknown): unknown {
  if (err instanceof IpcConnectError) {
    return new ServiceUnavailableError(
      `Gateway is not reachable over IPC: ${err.message}`,
    );
  }
  return err;
}

/**
 * If `err` is an {@link IpcConnectError}, throw 503. Otherwise return so the
 * caller can rethrow or map a more specific failure.
 */
export function throwIfGatewayIpcConnectFailed(err: unknown): void {
  const mapped = mapGatewayIpcConnectError(err);
  if (mapped !== err) {
    throw mapped;
  }
}

/**
 * Re-throw a gateway IPC failure as a route error.
 *
 * `IpcConnectError` becomes 503. Structured `IpcCallError` keeps the
 * gateway's statusCode/errorCode so 4xx engine reasons stay 4xx. Any other
 * throw propagates unchanged.
 */
export function rethrowGatewayIpcFailure(err: unknown): never {
  throwIfGatewayIpcConnectFailed(err);
  if (err instanceof IpcCallError) {
    throw new RouteError(
      err.message,
      err.errorCode ?? "INTERNAL_ERROR",
      err.statusCode ?? 500,
      err.errorDetails,
    );
  }
  throw err;
}

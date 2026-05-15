/**
 * A2A JSON-RPC error codes and helper functions.
 */

import type { JsonRpcResponse } from "./protocol-types.js";

// ── Standard JSON-RPC error codes ───────────────────────────────────

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

// ── A2A-specific error codes ────────────────────────────────────────

export const TASK_NOT_FOUND = -32001;
export const TASK_NOT_CANCELABLE = -32002;
export const PUSH_NOTIFICATION_NOT_SUPPORTED = -32003;
export const UNSUPPORTED_OPERATION = -32004;

// ── Helpers ─────────────────────────────────────────────────────────

export function makeJsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data !== undefined && { data }),
    },
  };
}

export function makeJsonRpcSuccess(
  id: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

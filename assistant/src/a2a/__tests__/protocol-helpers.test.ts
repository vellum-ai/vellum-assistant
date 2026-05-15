import { describe, expect, test } from "bun:test";

import { TERMINAL_TASK_STATES } from "../protocol-constants.js";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  makeJsonRpcError,
  makeJsonRpcSuccess,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  TASK_NOT_CANCELABLE,
  TASK_NOT_FOUND,
  UNSUPPORTED_OPERATION,
} from "../protocol-errors.js";

describe("makeJsonRpcError", () => {
  test("produces a valid JSON-RPC 2.0 error response", () => {
    const response = makeJsonRpcError(1, PARSE_ERROR, "Parse error");

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32700,
        message: "Parse error",
      },
    });
  });

  test("includes data field when provided", () => {
    const response = makeJsonRpcError(
      "req-1",
      INVALID_PARAMS,
      "Invalid params",
      { field: "message" },
    );

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: "req-1",
      error: {
        code: -32602,
        message: "Invalid params",
        data: { field: "message" },
      },
    });
  });

  test("omits data field when not provided", () => {
    const response = makeJsonRpcError(null, INTERNAL_ERROR, "Internal error");

    expect(response.error).toBeDefined();
    expect("data" in response.error!).toBe(false);
  });

  test("accepts null id", () => {
    const response = makeJsonRpcError(null, PARSE_ERROR, "Parse error");

    expect(response.id).toBeNull();
  });
});

describe("makeJsonRpcSuccess", () => {
  test("produces a valid JSON-RPC 2.0 success response", () => {
    const response = makeJsonRpcSuccess(1, { status: "ok" });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { status: "ok" },
    });
  });

  test("does not include an error field", () => {
    const response = makeJsonRpcSuccess("req-2", null);

    expect("error" in response).toBe(false);
    expect(response.result).toBeNull();
  });
});

describe("error code constants", () => {
  test("standard JSON-RPC codes", () => {
    expect(PARSE_ERROR).toBe(-32700);
    expect(INVALID_REQUEST).toBe(-32600);
    expect(METHOD_NOT_FOUND).toBe(-32601);
    expect(INVALID_PARAMS).toBe(-32602);
    expect(INTERNAL_ERROR).toBe(-32603);
  });

  test("A2A-specific codes", () => {
    expect(TASK_NOT_FOUND).toBe(-32001);
    expect(TASK_NOT_CANCELABLE).toBe(-32002);
    expect(UNSUPPORTED_OPERATION).toBe(-32004);
  });
});

describe("TERMINAL_TASK_STATES", () => {
  test("contains exactly the four terminal states", () => {
    expect(TERMINAL_TASK_STATES.size).toBe(4);
    expect(TERMINAL_TASK_STATES.has("completed")).toBe(true);
    expect(TERMINAL_TASK_STATES.has("failed")).toBe(true);
    expect(TERMINAL_TASK_STATES.has("canceled")).toBe(true);
    expect(TERMINAL_TASK_STATES.has("rejected")).toBe(true);
  });

  test("does not contain non-terminal states", () => {
    expect(TERMINAL_TASK_STATES.has("submitted")).toBe(false);
    expect(TERMINAL_TASK_STATES.has("working")).toBe(false);
    expect(TERMINAL_TASK_STATES.has("input_required")).toBe(false);
  });
});

/**
 * Unit tests for how `AssistantIpcServer.sendResult` handles a binary or
 * streaming handler result over the IPC transport.
 *
 * A `RouteResponse` (or a bare `Uint8Array` / `ReadableStream` / `Blob`)
 * wraps raw bytes that can't be carried as a JSON `result` field. Rather than
 * silently serialize the body into garbage, the server reports a structured
 * `BINARY_UNSUPPORTED_OVER_IPC` error; the gateway IPC proxy uses that signal
 * to fall back to the HTTP proxy, which streams binary responses correctly.
 */

import { describe, expect, test } from "bun:test";

import { RouteResponse } from "../../runtime/routes/types.js";
import { AssistantIpcServer } from "../assistant-server.js";

/**
 * `sendResult` is private; access it through an interface cast so the test
 * exercises the real production path without a test-only API on the class.
 */
type PrivateApi = {
  sendResult(
    socket: unknown,
    reader: unknown,
    requestId: string,
    value: unknown,
  ): void;
};

/**
 * Drive `sendResult` with a capturing socket in legacy (newline-delimited
 * JSON) mode — the same wire shape the gateway's IPC client speaks — and
 * return the parsed response envelope.
 */
function captureSendResult(value: unknown): Record<string, unknown> {
  const server = new AssistantIpcServer() as unknown as PrivateApi;
  const writes: string[] = [];
  const socket = {
    destroyed: false,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  };
  const reader = { isLegacy: true };

  server.sendResult(socket, reader, "req-1", value);

  expect(writes).toHaveLength(1);
  return JSON.parse(writes[0]) as Record<string, unknown>;
}

describe("AssistantIpcServer.sendResult binary handling", () => {
  test("a binary RouteResponse is reported as BINARY_UNSUPPORTED_OVER_IPC", () => {
    const env = captureSendResult(
      new RouteResponse(new Uint8Array([137, 80, 78, 71]), {
        "content-type": "image/png",
      }),
    );

    expect(env.id).toBe("req-1");
    expect(env.statusCode).toBe(421);
    expect(env.errorCode).toBe("BINARY_UNSUPPORTED_OVER_IPC");
    // The binary body must never be JSON-serialized into a `result` field.
    expect("result" in env).toBe(false);
  });

  test("a bare Uint8Array result is also reported as unsupported", () => {
    const env = captureSendResult(new Uint8Array([1, 2, 3]));

    expect(env.errorCode).toBe("BINARY_UNSUPPORTED_OVER_IPC");
    expect("result" in env).toBe(false);
  });

  test("a plain JSON result still serializes into `result`", () => {
    const env = captureSendResult({ ok: true, count: 2 });

    expect(env.result).toEqual({ ok: true, count: 2 });
    expect(env.errorCode).toBeUndefined();
  });
});

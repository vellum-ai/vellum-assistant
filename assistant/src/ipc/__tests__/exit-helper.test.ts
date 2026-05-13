/**
 * Unit tests for exitFromIpcResult exit-code matrix and daemon-down message.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";

delete process.env.ASSISTANT_IPC_SOCKET_DIR;

import { exitFromIpcResult } from "../cli-client.js";

// ---------------------------------------------------------------------------
// Exit-code matrix tests
// ---------------------------------------------------------------------------

describe("exitFromIpcResult", () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;

  const setupSpies = () => {
    exitSpy = spyOn(process, "exit").mockImplementation(
      (code?: number) => { throw new Error(`exit:${code}`); },
    );
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  };

  afterEach(() => {
    exitSpy?.mockRestore();
    stderrSpy?.mockRestore();
  });

  test("statusCode undefined → exit 10 (transport error)", () => {
    setupSpies();
    expect(() =>
      exitFromIpcResult({ ok: false, error: "Can't connect" }),
    ).toThrow("exit:10");
  });

  test("statusCode 404 → exit 2 (4xx)", () => {
    setupSpies();
    expect(() =>
      exitFromIpcResult({ ok: false, error: "Not found", statusCode: 404 }),
    ).toThrow("exit:2");
  });

  test("statusCode 422 → exit 2 (4xx boundary)", () => {
    setupSpies();
    expect(() =>
      exitFromIpcResult({ ok: false, error: "Unprocessable", statusCode: 422 }),
    ).toThrow("exit:2");
  });

  test("statusCode 500 → exit 3 (5xx)", () => {
    setupSpies();
    expect(() =>
      exitFromIpcResult({ ok: false, error: "Server error", statusCode: 500 }),
    ).toThrow("exit:3");
  });

  test("statusCode 503 → exit 3 (5xx boundary)", () => {
    setupSpies();
    expect(() =>
      exitFromIpcResult({ ok: false, error: "Unavailable", statusCode: 503 }),
    ).toThrow("exit:3");
  });

  test("statusCode 302 → exit 1 (generic fallback)", () => {
    setupSpies();
    expect(() =>
      exitFromIpcResult({ ok: false, error: "Redirect", statusCode: 302 }),
    ).toThrow("exit:1");
  });

  test("writes error message to stderr", () => {
    setupSpies();
    expect(() =>
      exitFromIpcResult({ ok: false, error: "Something went wrong", statusCode: 404 }),
    ).toThrow();
    expect(stderrSpy).toHaveBeenCalledWith("Something went wrong\n");
  });

  test("falls back to 'Unknown error' when error is undefined", () => {
    setupSpies();
    expect(() =>
      exitFromIpcResult({ ok: false }),
    ).toThrow("exit:10");
    expect(stderrSpy).toHaveBeenCalledWith("Unknown error\n");
  });
});

// ---------------------------------------------------------------------------
// Daemon-down message test
// ---------------------------------------------------------------------------

describe("daemon-down message", () => {
  test("contains socket path and assistant status hint", async () => {
    // Attempt to connect to a non-existent socket and check the error message
    const { cliIpcCall } = await import("../cli-client.js");
    const r = await cliIpcCall("any_method", {}, { timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("connect to the assistant at ");
    expect(r.error).toContain("assistant status");
  });
});

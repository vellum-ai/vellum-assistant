import { afterEach, describe, expect, test } from "bun:test";

import { runSanitizedBash } from "../sanitized-bash.js";

describe("runSanitizedBash", () => {
  const priorToken = process.env.CES_SERVICE_TOKEN;
  const priorSocket = process.env.CES_LOCAL_SOCKET;

  afterEach(() => {
    if (priorToken == null) {
      delete process.env.CES_SERVICE_TOKEN;
    } else {
      process.env.CES_SERVICE_TOKEN = priorToken;
    }
    if (priorSocket == null) {
      delete process.env.CES_LOCAL_SOCKET;
    } else {
      process.env.CES_LOCAL_SOCKET = priorSocket;
    }
  });

  test("runs a command and returns stdout", async () => {
    const result = await runSanitizedBash("echo hello", 5_000);
    expect(result.error).toBeUndefined();
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  test("forwards CES_SERVICE_TOKEN to the child", async () => {
    process.env.CES_SERVICE_TOKEN = "vault-bearer";
    const result = await runSanitizedBash("printenv CES_SERVICE_TOKEN", 5_000);
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("vault-bearer");
  });

  test("forwards CES_LOCAL_SOCKET to the child", async () => {
    process.env.CES_LOCAL_SOCKET = "/tmp/ces.sock";
    const result = await runSanitizedBash("printenv CES_LOCAL_SOCKET", 5_000);
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("/tmp/ces.sock");
  });

  test("times out a hung command", async () => {
    const result = await runSanitizedBash("sleep 5", 200);
    expect(result.error).toBeUndefined();
    expect(result.timedOut).toBe(true);
  });

  test("rejects an empty command", async () => {
    const result = await runSanitizedBash("");
    expect(result.error).toBe("command is required");
    expect(result.exitCode).toBeNull();
  });
});

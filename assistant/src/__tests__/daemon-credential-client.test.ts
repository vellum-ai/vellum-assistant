import { beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

/**
 * Mock only the IPC client (to simulate daemon-unreachable) and the logger.
 * Do NOT mock secure-keys.js — our daemon-credential-client reads directly
 * from it, so we test against the real module backed by the test workspace's
 * encrypted store.
 */

mock.module("../ipc/cli-client.js", () => ({
  cliIpcCall: async () => ({
    ok: false,
    error: "Could not connect to assistant daemon. Is it running?",
  }),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  getSecureKeyResultViaDaemon,
  getSecureKeyViaDaemon,
  setSecureKeyViaDaemon,
} from "../cli/lib/daemon-credential-client.js";
import { setSecureKeyAsync } from "../security/secure-keys.js";

describe("daemon credential read requests", () => {
  beforeEach(async () => {
    // Seed the real secure-keys store with test values
    await setSecureKeyAsync("openai", "sk-test-123");
    await setSecureKeyAsync(
      credentialKey("vellum", "platform_base_url"),
      "https://api.vellum.ai",
    );
    await setSecureKeyAsync(
      credentialKey("google", "client_secret"),
      "google-secret",
    );
  });

  test("reads go directly to secure-keys without daemon", async () => {
    const value = await getSecureKeyViaDaemon("openai");
    expect(value).toBe("sk-test-123");
  });

  test("reads canonical credential keys directly", async () => {
    const key = credentialKey("vellum", "platform_base_url");
    const value = await getSecureKeyViaDaemon(key);
    expect(value).toBe("https://api.vellum.ai");
  });

  test("getSecureKeyResultViaDaemon returns structured result", async () => {
    const key = credentialKey("google", "client_secret");
    const result = await getSecureKeyResultViaDaemon(key);
    expect(result.value).toBe("google-secret");
    expect(result.unreachable).toBe(false);
  });

  test("returns undefined for missing keys", async () => {
    const value = await getSecureKeyViaDaemon("nonexistent");
    expect(value).toBeUndefined();
  });
});

describe("daemon credential writes (daemon unreachable)", () => {
  test("falls back to direct write when daemon is not running", async () => {
    const result = await setSecureKeyViaDaemon(
      "api_key",
      "test-provider",
      "test-value",
    );
    expect(result).toBe(true);

    // Verify the value was written directly
    const readBack = await getSecureKeyViaDaemon("test-provider");
    expect(readBack).toBe("test-value");
  });
});

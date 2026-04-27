import { describe, expect, mock, test } from "bun:test";

/**
 * Mock only the IPC client (to simulate daemon-unreachable) and the logger.
 * Do NOT mock secure-keys.js — daemon-credential-client falls back to it
 * for writes/deletes when the daemon is unreachable.
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

import { setSecureKeyViaDaemon } from "../cli/lib/daemon-credential-client.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";

describe("daemon credential writes (daemon unreachable)", () => {
  test("falls back to direct write when daemon is not running", async () => {
    const result = await setSecureKeyViaDaemon(
      "api_key",
      "test-provider",
      "test-value",
    );
    expect(result).toBe(true);

    const readBack = await getSecureKeyAsync("test-provider");
    expect(readBack).toBe("test-value");
  });
});

import { describe, expect, mock, test } from "bun:test";

/**
 * Mock the IPC client and logger. The IPC mock returns configurable
 * responses so we can test all three paths:
 *   1. Daemon reachable + success
 *   2. Daemon reachable + failure (success=false)
 *   3. Daemon unreachable
 *
 * Do NOT mock secure-keys.js — daemon-credential-client falls back to it
 * for writes/deletes when the daemon is unreachable or returns failure.
 */

let _ipcResponse: { ok: boolean; result?: unknown; error?: string } = {
  ok: false,
  error: "Could not connect to assistant daemon. Is it running?",
};

mock.module("../ipc/cli-client.js", () => ({
  cliIpcCall: async () => _ipcResponse,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  deleteSecureKeyViaDaemon,
  setSecureKeyViaDaemon,
} from "../cli/lib/daemon-credential-client.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";

describe("daemon credential client", () => {
  describe("set — daemon unreachable", () => {
    test("falls back to direct write when daemon is not running", async () => {
      _ipcResponse = {
        ok: false,
        error: "Could not connect to assistant daemon. Is it running?",
      };

      const result = await setSecureKeyViaDaemon(
        "api_key",
        "test-provider",
        "test-value",
      );
      expect(result).toBe(true);

      const readBack = await getSecureKeyAsync(
        credentialKey("test-provider", "api_key"),
      );
      expect(readBack).toBe("test-value");
    });
  });

  describe("set — daemon returns success=false", () => {
    test("falls back to direct write on daemon failure", async () => {
      _ipcResponse = {
        ok: true,
        result: { success: false },
      };

      const result = await setSecureKeyViaDaemon(
        "credential",
        "vellum:webhook_secret",
        "fallback-value",
      );
      expect(result).toBe(true);

      const readBack = await getSecureKeyAsync(
        credentialKey("vellum", "webhook_secret"),
      );
      expect(readBack).toBe("fallback-value");
    });
  });

  describe("delete — daemon returns success=false", () => {
    test("falls back to direct delete on daemon failure", async () => {
      // First, write a credential directly so we can delete it.
      _ipcResponse = {
        ok: false,
        error: "Could not connect to assistant daemon. Is it running?",
      };
      await setSecureKeyViaDaemon(
        "credential",
        "vellum:temp_cred",
        "to-delete",
      );

      // Verify it exists.
      const before = await getSecureKeyAsync(
        credentialKey("vellum", "temp_cred"),
      );
      expect(before).toBe("to-delete");

      // Now simulate daemon reachable but delete fails.
      _ipcResponse = {
        ok: true,
        result: { success: false },
      };
      const result = await deleteSecureKeyViaDaemon(
        "credential",
        "vellum:temp_cred",
      );
      expect(result).toBe("deleted");

      // Verify it's gone.
      const after = await getSecureKeyAsync(
        credentialKey("vellum", "temp_cred"),
      );
      expect(after).toBeUndefined();
    });
  });
});

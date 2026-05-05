import { describe, expect, mock, test } from "bun:test";

/**
 * Mock the IPC client and logger. The IPC mock returns configurable
 * responses so we can test success, failure, and unreachable paths.
 *
 * Do NOT mock secure-keys.js — daemon-credential-client falls back to it
 * for writes/deletes when the daemon is unreachable.
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
      expect(result.ok).toBe(true);

      const readBack = await getSecureKeyAsync(
        credentialKey("test-provider", "api_key"),
      );
      expect(readBack).toBe("test-value");
    });
  });

  describe("set — daemon error", () => {
    test("surfaces daemon error message on IPC failure", async () => {
      _ipcResponse = {
        ok: false,
        error:
          "Failed to store credential in secure storage (backend: ces-rpc)",
      };

      const result = await setSecureKeyViaDaemon(
        "credential",
        "vellum:webhook_secret",
        "some-value",
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe(
        "Failed to store credential in secure storage (backend: ces-rpc)",
      );
    });

    test("surfaces validation error from daemon result", async () => {
      _ipcResponse = {
        ok: true,
        result: {
          success: false,
          error: "API key validation failed: invalid format",
        },
      };

      const result = await setSecureKeyViaDaemon(
        "api_key",
        "anthropic",
        "bad-key",
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe("API key validation failed: invalid format");
    });
  });

  describe("delete — daemon error", () => {
    test("surfaces daemon error message", async () => {
      _ipcResponse = {
        ok: false,
        error: "Credential store is unreachable",
      };

      const result = await deleteSecureKeyViaDaemon(
        "credential",
        "vellum:temp_cred",
      );
      expect(result.result).toBe("error");
      expect(result.error).toBe("Credential store is unreachable");
    });

    test("returns not-found for 404 errors", async () => {
      _ipcResponse = {
        ok: false,
        error: "Credential not found (404)",
      };

      const result = await deleteSecureKeyViaDaemon(
        "credential",
        "vellum:missing",
      );
      expect(result.result).toBe("not-found");
      expect(result.error).toBeUndefined();
    });
  });
});

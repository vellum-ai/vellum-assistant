import { beforeEach, describe, expect, mock, test } from "bun:test";

import { CesRpcMethod } from "@vellumai/ces-contracts";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

const callFn = mock(
  async (_method: string, _request: unknown): Promise<unknown> => ({}),
);

const isReadyFn = mock((): boolean => true);

// ---------------------------------------------------------------------------
// Mock modules — before importing module under test
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Import after mocking
import type { CesClient } from "../credential-execution/client.js";
import { CesRpcCredentialBackend } from "../security/ces-rpc-credential-backend.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(): CesClient {
  return {
    handshake: mock(async () => ({ accepted: true })),
    call: callFn as CesClient["call"],
    updateAssistantApiKey: mock(async () => ({ updated: true })),
    isReady: isReadyFn,
    close: mock(() => {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CesRpcCredentialBackend", () => {
  let client: CesClient;
  let backend: CesRpcCredentialBackend;

  beforeEach(() => {
    callFn.mockClear();
    isReadyFn.mockClear();

    isReadyFn.mockReturnValue(true);

    client = createMockClient();
    backend = new CesRpcCredentialBackend(client);
  });

  test("has name 'ces-rpc'", () => {
    expect(backend.name).toBe("ces-rpc");
  });

  // -------------------------------------------------------------------------
  // isAvailable
  // -------------------------------------------------------------------------

  describe("isAvailable", () => {
    test("returns true when client is ready", () => {
      isReadyFn.mockReturnValue(true);
      expect(backend.isAvailable()).toBe(true);
    });

    test("returns false when client is not ready", () => {
      isReadyFn.mockReturnValue(false);
      expect(backend.isAvailable()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  describe("get", () => {
    test("delegates to CesRpcMethod.GetCredential and returns value when found", async () => {
      callFn.mockResolvedValue({ found: true, value: "my-secret" });

      const result = await backend.get("test-account");

      expect(callFn).toHaveBeenCalledWith(CesRpcMethod.GetCredential, {
        account: "test-account",
      });
      expect(result).toEqual({ value: "my-secret", unreachable: false });
    });

    test("returns undefined value when credential not found", async () => {
      callFn.mockResolvedValue({ found: false });

      const result = await backend.get("missing-account");

      expect(callFn).toHaveBeenCalledWith(CesRpcMethod.GetCredential, {
        account: "missing-account",
      });
      expect(result).toEqual({ value: undefined, unreachable: false });
    });

    test("returns unreachable when RPC call throws", async () => {
      callFn.mockRejectedValue(new Error("transport error"));

      const result = await backend.get("broken-account");

      expect(result).toEqual({ value: undefined, unreachable: true });
    });
  });

  // -------------------------------------------------------------------------
  // set
  // -------------------------------------------------------------------------

  describe("set", () => {
    test("delegates to CesRpcMethod.SetCredential and returns true on success", async () => {
      callFn.mockResolvedValue({ ok: true });

      const result = await backend.set("test-account", "new-secret");

      expect(callFn).toHaveBeenCalledWith(CesRpcMethod.SetCredential, {
        account: "test-account",
        value: "new-secret",
      });
      expect(result).toBe(true);
    });

    test("returns false when RPC call throws", async () => {
      callFn.mockRejectedValue(new Error("transport error"));

      const result = await backend.set("test-account", "new-secret");

      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  describe("delete", () => {
    test("delegates to CesRpcMethod.DeleteCredential and returns the result", async () => {
      callFn.mockResolvedValue({ result: "deleted" });

      const result = await backend.delete("test-account");

      expect(callFn).toHaveBeenCalledWith(CesRpcMethod.DeleteCredential, {
        account: "test-account",
      });
      expect(result).toBe("deleted");
    });

    test("returns not-found result from CES", async () => {
      callFn.mockResolvedValue({ result: "not-found" });

      const result = await backend.delete("nonexistent-account");

      expect(result).toBe("not-found");
    });

    test("returns 'error' when RPC call throws", async () => {
      callFn.mockRejectedValue(new Error("transport error"));

      const result = await backend.delete("test-account");

      expect(result).toBe("error");
    });
  });

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  describe("list", () => {
    test("delegates to CesRpcMethod.ListCredentials and returns accounts", async () => {
      callFn.mockResolvedValue({ accounts: ["account-a", "account-b"] });

      const result = await backend.list();

      expect(callFn).toHaveBeenCalledWith(CesRpcMethod.ListCredentials, {});
      expect(result).toEqual({
        accounts: ["account-a", "account-b"],
        unreachable: false,
      });
    });

    test("returns unreachable when RPC call throws", async () => {
      callFn.mockRejectedValue(new Error("transport error"));

      const result = await backend.list();

      expect(result).toEqual({ accounts: [], unreachable: true });
    });
  });
});

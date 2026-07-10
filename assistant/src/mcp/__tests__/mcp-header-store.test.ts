import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must precede imports) ───────────────────────────────────────

// In-memory secure key backend shared by the header blob store and the
// resolved credential values.
const secureStore = new Map<string, string>();

mock.module("../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (k: string) => secureStore.get(k),
  setSecureKeyAsync: async (k: string, v: string) => {
    secureStore.set(k, v);
    return true;
  },
  deleteSecureKeyAsync: async (k: string) => {
    secureStore.delete(k);
    return "deleted";
  },
  getSecureKeyResultAsync: async (k: string) => ({
    value: secureStore.get(k),
    unreachable: false,
  }),
}));

// Credentials that "exist" in the vault, keyed by "service/field" → storageKey.
const existingCredentials = new Map<string, string>();

mock.module("../../tools/credentials/resolve.js", () => ({
  resolveCredentialRef: (ref: string) => {
    const storageKey = existingCredentials.get(ref);
    if (!storageKey) {
      return undefined;
    }
    const [service, field] = ref.split("/");
    return {
      credentialId: ref,
      service,
      field,
      storageKey,
      injectionTemplates: [],
      metadata: {},
    };
  },
}));

// ── Import SUT after mocks ────────────────────────────────────────────────────

const {
  buildMissingCredentialCommand,
  getMcpHeaderEnvelope,
  McpHeaderResolutionError,
  resolveMcpHeaders,
  setMcpHeaderEnvelope,
  setMcpHeaders,
} = await import("../mcp-header-store.js");

const HEADERS_KEY = "mcp:srv:headers";

beforeEach(() => {
  secureStore.clear();
  existingCredentials.clear();
});

describe("mcp-header-store", () => {
  describe("legacy read-compat", () => {
    test("normalizes a flat Record<string,string> blob into a v2 envelope", async () => {
      secureStore.set(
        HEADERS_KEY,
        JSON.stringify({ Authorization: "Bearer legacy-tok" }),
      );

      const envelope = await getMcpHeaderEnvelope("srv");
      expect(envelope).toEqual({
        version: 2,
        literals: { Authorization: "Bearer legacy-tok" },
        refs: [],
      });

      const resolved = await resolveMcpHeaders("srv");
      expect(resolved).toEqual({ Authorization: "Bearer legacy-tok" });
    });

    test("returns undefined when nothing is stored", async () => {
      expect(await getMcpHeaderEnvelope("srv")).toBeUndefined();
      expect(await resolveMcpHeaders("srv")).toEqual({});
    });
  });

  describe("v2 envelope round-trip", () => {
    test("persists and reads back literals and refs", async () => {
      const envelope = {
        version: 2 as const,
        literals: { "X-Trace": "on" },
        refs: [
          {
            headerName: "Authorization",
            service: "reducto",
            field: "api_key",
            prefix: "Bearer ",
          },
        ],
      };
      expect(await setMcpHeaderEnvelope("srv", envelope)).toBe(true);
      expect(await getMcpHeaderEnvelope("srv")).toEqual(envelope);
    });

    test("setMcpHeaders stores literal-only envelopes", async () => {
      await setMcpHeaders("srv", { "X-API-Key": "abc" });
      expect(await getMcpHeaderEnvelope("srv")).toEqual({
        version: 2,
        literals: { "X-API-Key": "abc" },
        refs: [],
      });
    });
  });

  describe("ref resolution", () => {
    test("resolves a ref with prefix through the vault", async () => {
      existingCredentials.set("reducto/api_key", "credkey-1");
      secureStore.set("credkey-1", "sk-secret-123");

      await setMcpHeaderEnvelope("srv", {
        version: 2,
        literals: {},
        refs: [
          {
            headerName: "Authorization",
            service: "reducto",
            field: "api_key",
            prefix: "Bearer ",
          },
        ],
      });

      expect(await resolveMcpHeaders("srv")).toEqual({
        Authorization: "Bearer sk-secret-123",
      });
    });

    test("resolves a ref without a prefix", async () => {
      existingCredentials.set("acme/key", "credkey-2");
      secureStore.set("credkey-2", "raw-key");

      await setMcpHeaderEnvelope("srv", {
        version: 2,
        literals: {},
        refs: [{ headerName: "X-API-Key", service: "acme", field: "key" }],
      });

      expect(await resolveMcpHeaders("srv")).toEqual({
        "X-API-Key": "raw-key",
      });
    });

    test("refs win over literals on header-name collision", async () => {
      existingCredentials.set("reducto/api_key", "credkey-3");
      secureStore.set("credkey-3", "fresh-token");

      await setMcpHeaderEnvelope("srv", {
        version: 2,
        literals: { Authorization: "Bearer stale-literal" },
        refs: [
          {
            headerName: "Authorization",
            service: "reducto",
            field: "api_key",
            prefix: "Bearer ",
          },
        ],
      });

      expect(await resolveMcpHeaders("srv")).toEqual({
        Authorization: "Bearer fresh-token",
      });
    });
  });

  describe("missing credential behavior", () => {
    test("throws McpHeaderResolutionError when a ref is unknown", async () => {
      await setMcpHeaderEnvelope("srv", {
        version: 2,
        literals: {},
        refs: [{ headerName: "Authorization", service: "gone", field: "key" }],
      });

      const promise = resolveMcpHeaders("srv");
      await expect(promise).rejects.toBeInstanceOf(McpHeaderResolutionError);
      await expect(promise).rejects.toMatchObject({
        serverId: "srv",
        missing: [
          { headerName: "Authorization", service: "gone", field: "key" },
        ],
      });
    });

    test("throws when the credential exists but resolves to an empty value", async () => {
      existingCredentials.set("empty/key", "credkey-empty");
      secureStore.set("credkey-empty", "");

      await setMcpHeaderEnvelope("srv", {
        version: 2,
        literals: {},
        refs: [{ headerName: "Authorization", service: "empty", field: "key" }],
      });

      await expect(resolveMcpHeaders("srv")).rejects.toBeInstanceOf(
        McpHeaderResolutionError,
      );
    });
  });

  describe("buildMissingCredentialCommand", () => {
    test("produces the exact credentials prompt command", () => {
      expect(buildMissingCredentialCommand("reducto", "api_key")).toBe(
        'assistant credentials prompt --service reducto --field api_key --label "reducto api key"',
      );
    });
  });
});

/**
 * Tests for A2A config handler.
 *
 * Uses the real DB (via `initializeDb()`) and the test preload which sets
 * `VELLUM_WORKSPACE_DIR` to a per-file temp directory.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../../config/loader.js";
import { findContactByAddress } from "../../../contacts/contact-store.js";
import { getSqlite } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import {
  clearA2AConfig,
  getA2AConfig,
  resolveGuardianHandle,
  setA2AConfig,
} from "../config-a2a.js";

initializeDb();

const resolvePublicHost = async () => ["93.184.216.34"];

function resetTables(): void {
  const sqlite = getSqlite();
  sqlite.run("DELETE FROM assistant_contact_metadata");
  sqlite.run("DELETE FROM contact_channels");
  sqlite.run("DELETE FROM contacts");
}

function setConfigEnabled(enabled: boolean): void {
  const raw = loadRawConfig();
  setNestedValue(raw, "a2a.enabled", enabled);
  saveRawConfig(raw);
  invalidateConfigCache();
}

describe("getA2AConfig", () => {
  beforeEach(() => {
    resetTables();
    setConfigEnabled(false);
  });

  test("returns enabled: false when a2a is disabled", () => {
    const result = getA2AConfig();
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(false);
    expect(result.activeConnections).toBe(0);
  });

  test("returns enabled: true when a2a is enabled", () => {
    setConfigEnabled(true);
    const result = getA2AConfig();
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
  });
});

describe("setA2AConfig", () => {
  beforeEach(() => {
    resetTables();
    setConfigEnabled(false);
  });

  test("enables a2a in config", () => {
    const result = setA2AConfig();
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
  });

  test("is idempotent", () => {
    setA2AConfig();
    const result = setA2AConfig();
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
  });
});

describe("clearA2AConfig", () => {
  beforeEach(() => {
    resetTables();
    setConfigEnabled(true);
  });

  test("disables a2a in config", () => {
    const result = clearA2AConfig();
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(false);
  });
});

describe("resolveGuardianHandle", () => {
  test("fetches the normalized agent card URL with timeout and no redirects", async () => {
    const originalFetch = globalThis.fetch;
    let captured:
      | { input: string | URL | Request; init: RequestInit | undefined }
      | undefined;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      captured = { input, init };
      return new Response(JSON.stringify({ name: "Peer Bot" }), {
        status: 200,
      });
    }) as typeof fetch;

    try {
      const result = await resolveGuardianHandle(
        "peer-handle",
        "https://peer.example.com/some/path?ignored=true",
        { resolveHostAddresses: resolvePublicHost },
      );

      expect(result).toEqual({
        assistantId: "peer-handle",
        gatewayUrl: "https://peer.example.com",
        displayName: "Peer Bot",
      });
      expect(captured).toBeDefined();
      expect(captured!.input).toBe(
        "https://peer.example.com/.well-known/agent-card.json",
      );
      expect(captured!.init?.redirect).toBe("manual");
      expect(captured!.init?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    ["http://peer.example.com", "https"],
    ["https://127.0.0.1", "local or private network"],
    ["https://169.254.169.254", "local or private network"],
    ["https://metadata.google.internal", "local or private network"],
    ["https://peer.example.com/admin#", "fragment"],
  ] as const)("rejects unsafe gatewayUrl %s", async (gatewayUrl, message) => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      fetchCalled = true;
      return new Response("{}");
    }) as typeof fetch;

    try {
      await expect(
        resolveGuardianHandle("peer-handle", gatewayUrl, {
          resolveHostAddresses: resolvePublicHost,
        }),
      ).rejects.toThrow(message);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects a gateway host that resolves to a private address", async () => {
    await expect(
      resolveGuardianHandle("peer-handle", "https://peer.example.com", {
        resolveHostAddresses: async () => ["10.0.0.5"],
      }),
    ).rejects.toThrow("local or private network");
  });

  test("does not reflect upstream response bodies in agent card errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      return new Response("internal metadata secret", { status: 404 });
    }) as typeof fetch;

    try {
      let error: unknown;
      try {
        await resolveGuardianHandle("peer-handle", "https://peer.example.com", {
          resolveHostAddresses: resolvePublicHost,
        });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Agent card fetch failed with status 404.",
      );
      expect((error as Error).message).not.toContain(
        "internal metadata secret",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("connectToAssistant", () => {
  beforeEach(() => {
    resetTables();
  });

  test("returns error when gatewayUrl is not provided and handle cannot be resolved", async () => {
    const { connectToAssistant } = await import("../config-a2a.js");
    const result = await connectToAssistant({
      guardianHandle: "peer-assistant",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("gatewayUrl");
  });

  test("detects duplicate connection and returns alreadyConnected", async () => {
    // Manually create a contact with an a2a channel to simulate existing connection
    const { upsertContact } =
      await import("../../../contacts/contact-store.js");
    upsertContact({
      displayName: "Peer Bot",
      contactType: "assistant",
      role: "contact",
      channels: [
        {
          type: "a2a",
          address: "peer-handle",
          externalUserId: "peer-handle",
          status: "active",
          policy: "allow",
        },
      ],
    });

    // Verify the contact exists
    const existing = findContactByAddress("a2a", "peer-handle");
    expect(existing).not.toBeNull();

    // Mock resolveGuardianHandle to return matching data
    const { connectToAssistant } = await import("../config-a2a.js");

    // We need to mock the fetch for the agent card
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (url.includes("agent-card.json")) {
        return new Response(JSON.stringify({ name: "Peer Bot" }), {
          status: 200,
        });
      }
      // Return success for message:send
      return new Response(JSON.stringify({ task: { id: "t1" } }), {
        status: 200,
      });
    }) as typeof fetch;

    try {
      const result = await connectToAssistant({
        guardianHandle: "peer-handle",
        gatewayUrl: "https://peer.example.com",
        resolveHostAddresses: resolvePublicHost,
      });
      expect(result.success).toBe(true);
      expect(result.alreadyConnected).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

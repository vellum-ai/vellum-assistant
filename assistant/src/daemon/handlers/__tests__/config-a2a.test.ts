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
import { clearA2AConfig, getA2AConfig, setA2AConfig } from "../config-a2a.js";

initializeDb();

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
      });
      expect(result.success).toBe(true);
      expect(result.alreadyConnected).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

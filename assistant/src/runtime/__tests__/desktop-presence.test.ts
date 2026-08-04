/**
 * Tests for the desktop presence policy.
 *
 * The invariant under test is fail-open: only a fresh `active` report from a
 * `macos` client answers `true`. Every other shape (stale, idle, away, no
 * presence, wrong interface, no clients, hub throw) answers `false` so the
 * push is sent.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { InterfaceId } from "../../channels/types.js";
import {
  assistantEventHub,
  type DesktopPresenceState,
} from "../assistant-event-hub.js";
import {
  isDesktopAttended,
  PRESENCE_STALE_AFTER_MS,
} from "../desktop-presence.js";

// ── Test helpers ──────────────────────────────────────────────────────────

function registerClient(args: {
  clientId: string;
  interfaceId?: InterfaceId;
  presence?: DesktopPresenceState;
}): void {
  assistantEventHub.subscribe({
    type: "client",
    clientId: args.clientId,
    interfaceId: args.interfaceId ?? "macos",
    capabilities: [],
    callback: () => {},
  });
  if (args.presence) {
    assistantEventHub.setClientPresence(args.clientId, args.presence);
  }
}

function clearHub(): void {
  for (const client of assistantEventHub.listClients()) {
    assistantEventHub.disposeClient(client.clientId);
  }
}

/** A `now` far enough past every report to push all of them out of the window. */
function afterStaleness(): Date {
  return new Date(Date.now() + PRESENCE_STALE_AFTER_MS + 1_000);
}

afterEach(() => {
  clearHub();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("isDesktopAttended", () => {
  test("fresh active macos client is attended", () => {
    registerClient({ clientId: "mac-1", presence: "active" });
    expect(isDesktopAttended()).toBe(true);
  });

  test("active report older than the staleness bound is not attended", () => {
    registerClient({ clientId: "mac-1", presence: "active" });
    expect(isDesktopAttended(afterStaleness())).toBe(false);
  });

  test("idle is not attended", () => {
    registerClient({ clientId: "mac-1", presence: "idle" });
    expect(isDesktopAttended()).toBe(false);
  });

  test("away is not attended", () => {
    registerClient({ clientId: "mac-1", presence: "away" });
    expect(isDesktopAttended()).toBe(false);
  });

  test("client that never reported presence is not attended", () => {
    registerClient({ clientId: "mac-1" });
    expect(isDesktopAttended()).toBe(false);
  });

  test("active web client does not count as desktop presence", () => {
    registerClient({
      clientId: "web-1",
      interfaceId: "web",
      presence: "active",
    });
    expect(isDesktopAttended()).toBe(false);
  });

  test("no connected clients is not attended", () => {
    expect(isDesktopAttended()).toBe(false);
  });

  test("a hub read that throws is not attended", () => {
    const spy = spyOn(
      assistantEventHub,
      "listClientsByInterface",
    ).mockImplementation(() => {
      throw new Error("hub exploded");
    });
    try {
      expect(isDesktopAttended()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("one active macos client among several is enough", () => {
    registerClient({ clientId: "mac-1", presence: "away" });
    registerClient({ clientId: "mac-2", presence: "active" });
    expect(isDesktopAttended()).toBe(true);
  });
});

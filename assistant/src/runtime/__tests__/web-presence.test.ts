/**
 * Tests for the web presence policy.
 *
 * The invariant under test is fail-open: only a fresh report from a `web`
 * client with `visible: true` and a matching `focusedConversationId` answers
 * `true`. Every other shape (stale, hidden, mismatched conversation, no
 * report, wrong interface, no clients, hub throw) answers `false` so the push
 * is sent. Scoping the read to an actor principal narrows what counts as
 * focus, so it can only ever turn a `true` into a `false`.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  clearHubClients,
  registerHubClient,
  type RegisterHubClientArgs,
} from "../../__tests__/helpers/hub-clients.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import {
  isWebConversationFocused,
  WEB_PRESENCE_STALE_AFTER_MS,
} from "../web-presence.js";

const CONVERSATION_ID = "conv-1";

// ── Test helpers ──────────────────────────────────────────────────────────

/** A `now` far enough past every report to push all of them out of the window. */
function afterStaleness(): Date {
  return new Date(Date.now() + WEB_PRESENCE_STALE_AFTER_MS + 1_000);
}

function registerClient(
  args: Omit<RegisterHubClientArgs, "hub" | "presence">,
): void {
  registerHubClient({ ...args, hub: assistantEventHub, interfaceId: "web" });
}

function reportWebPresence(
  clientId: string,
  report: { visible: boolean; focusedConversationId: string | null },
): void {
  assistantEventHub.setClientWebPresence(clientId, report);
}

function clientEntry(clientId: string) {
  const client = assistantEventHub
    .listClientsByInterface("web")
    .find((entry) => entry.clientId === clientId);
  if (!client) {
    throw new Error(`missing test client ${clientId}`);
  }
  return client;
}

afterEach(() => {
  clearHubClients(assistantEventHub);
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("isWebConversationFocused", () => {
  test("fresh visible report focused on the conversation is focused", () => {
    registerClient({ clientId: "web-1" });
    reportWebPresence("web-1", {
      visible: true,
      focusedConversationId: CONVERSATION_ID,
    });
    expect(isWebConversationFocused(CONVERSATION_ID)).toBe(true);
  });

  test("report older than the staleness bound is not focused", () => {
    registerClient({ clientId: "web-1" });
    reportWebPresence("web-1", {
      visible: true,
      focusedConversationId: CONVERSATION_ID,
    });
    expect(
      isWebConversationFocused(CONVERSATION_ID, { now: afterStaleness() }),
    ).toBe(false);
  });

  test("semantic report expires even while SSE transport stays alive", () => {
    registerClient({ clientId: "web-1" });
    reportWebPresence("web-1", {
      visible: true,
      focusedConversationId: CONVERSATION_ID,
    });
    const now = new Date(Date.now() + WEB_PRESENCE_STALE_AFTER_MS + 1_000);
    clientEntry("web-1").lastActiveAt = now;

    expect(isWebConversationFocused(CONVERSATION_ID, { now })).toBe(false);
  });

  test("transport expiry is not focused even with a fresh semantic report", () => {
    registerClient({ clientId: "web-1" });
    reportWebPresence("web-1", {
      visible: true,
      focusedConversationId: CONVERSATION_ID,
    });
    const now = new Date();
    clientEntry("web-1").lastActiveAt = new Date(
      now.getTime() - WEB_PRESENCE_STALE_AFTER_MS - 1_000,
    );
    clientEntry("web-1").webPresence!.reportedAt = now;

    expect(isWebConversationFocused(CONVERSATION_ID, { now })).toBe(false);
  });

  test("hidden tab is not focused even on the matching conversation", () => {
    registerClient({ clientId: "web-1" });
    reportWebPresence("web-1", {
      visible: false,
      focusedConversationId: CONVERSATION_ID,
    });
    expect(isWebConversationFocused(CONVERSATION_ID)).toBe(false);
  });

  test("visible tab focused on a different conversation is not focused", () => {
    registerClient({ clientId: "web-1" });
    reportWebPresence("web-1", {
      visible: true,
      focusedConversationId: "conv-other",
    });
    expect(isWebConversationFocused(CONVERSATION_ID)).toBe(false);
  });

  test("visible tab with no focused conversation is not focused", () => {
    registerClient({ clientId: "web-1" });
    reportWebPresence("web-1", { visible: true, focusedConversationId: null });
    expect(isWebConversationFocused(CONVERSATION_ID)).toBe(false);
  });

  test("client that never reported presence is not focused", () => {
    registerClient({ clientId: "web-1" });
    expect(isWebConversationFocused(CONVERSATION_ID)).toBe(false);
  });

  test("a macos client's presence does not count as web focus", () => {
    registerHubClient({
      hub: assistantEventHub,
      clientId: "mac-1",
      interfaceId: "macos",
    });
    assistantEventHub.setClientWebPresence("mac-1", {
      visible: true,
      focusedConversationId: CONVERSATION_ID,
    });
    expect(isWebConversationFocused(CONVERSATION_ID)).toBe(false);
  });

  test("no connected clients is not focused", () => {
    expect(isWebConversationFocused(CONVERSATION_ID)).toBe(false);
  });

  test("a hub read that throws is not focused", () => {
    const spy = spyOn(
      assistantEventHub,
      "listClientsByInterface",
    ).mockImplementation(() => {
      throw new Error("hub exploded");
    });
    try {
      expect(isWebConversationFocused(CONVERSATION_ID)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("one focused web client among several is enough", () => {
    registerClient({ clientId: "web-1" });
    registerClient({ clientId: "web-2" });
    reportWebPresence("web-1", {
      visible: true,
      focusedConversationId: "conv-other",
    });
    reportWebPresence("web-2", {
      visible: true,
      focusedConversationId: CONVERSATION_ID,
    });
    expect(isWebConversationFocused(CONVERSATION_ID)).toBe(true);
  });
});

describe("isWebConversationFocused scoped to an actor principal", () => {
  test("matching actor principal is focused", () => {
    registerClient({ clientId: "web-1", actorPrincipalId: "actor-a" });
    reportWebPresence("web-1", {
      visible: true,
      focusedConversationId: CONVERSATION_ID,
    });
    expect(
      isWebConversationFocused(CONVERSATION_ID, {
        actorPrincipalId: "actor-a",
      }),
    ).toBe(true);
  });

  test("another actor's focused tab does not count", () => {
    registerClient({ clientId: "web-1", actorPrincipalId: "actor-a" });
    reportWebPresence("web-1", {
      visible: true,
      focusedConversationId: CONVERSATION_ID,
    });
    expect(
      isWebConversationFocused(CONVERSATION_ID, {
        actorPrincipalId: "actor-b",
      }),
    ).toBe(false);
  });

  test("client with no principal does not match a supplied principal", () => {
    registerClient({ clientId: "web-1" });
    reportWebPresence("web-1", {
      visible: true,
      focusedConversationId: CONVERSATION_ID,
    });
    expect(
      isWebConversationFocused(CONVERSATION_ID, {
        actorPrincipalId: "actor-a",
      }),
    ).toBe(false);
  });

  test("omitting the principal counts any focused web client", () => {
    registerClient({ clientId: "web-1", actorPrincipalId: "actor-a" });
    reportWebPresence("web-1", {
      visible: true,
      focusedConversationId: CONVERSATION_ID,
    });
    expect(isWebConversationFocused(CONVERSATION_ID)).toBe(true);
  });
});

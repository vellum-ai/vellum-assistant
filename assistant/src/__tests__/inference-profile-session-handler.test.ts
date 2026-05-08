/**
 * Tests for the shared inference-profile session handler.
 *
 * Covers: setInferenceProfileSession, closeInferenceProfileSession,
 * and listInferenceProfileSessionsWithRemaining.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// Stub the event hub so tests don't need a running event bus.
// Exposed as a `mock(...)` so individual tests can assert publish calls.
const publishMock = mock(async () => {});
mock.module("../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: { publish: publishMock },
}));

// Stub buildAssistantEvent to be an identity pass-through for the event object
mock.module("../runtime/assistant-event.js", () => ({
  buildAssistantEvent: (event: unknown) => event,
}));

// ---------------------------------------------------------------------------
// Config mock — controlled per test so we can inject profiles
// ---------------------------------------------------------------------------

let mockProfiles: Record<string, unknown> = {};
let mockMaxTtl: number | undefined;

mock.module("../config/loader.js", () => ({
  loadConfig: () => ({
    llm: {
      profiles: mockProfiles,
      profileSession: {
        defaultTtlSeconds: 1800,
        maxTtlSeconds: mockMaxTtl ?? 43200,
      },
    },
  }),
}));

// ---------------------------------------------------------------------------
// Real DB — same pattern as conversation-crud-inference-profile.test.ts
// ---------------------------------------------------------------------------

import { createConversation, getConversation } from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";

initializeDb();

import {
  closeInferenceProfileSession,
  listInferenceProfileSessionsWithRemaining,
  setInferenceProfileSession,
} from "../runtime/routes/inference-profile-session-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetDb() {
  const db = getDb();
  db.run(`DELETE FROM messages`);
  db.run(`DELETE FROM conversations`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setInferenceProfileSession", () => {
  beforeEach(() => {
    resetDb();
    mockProfiles = { balanced: {}, "cost-optimized": {} };
    mockMaxTtl = undefined; // reset to default 43200
    publishMock.mockClear();
  });

  test("open with ttlSeconds=600 — returns UUID sessionId and expiresAt ≈ now + 600_000", async () => {
    const conv = createConversation("sess-handler-ttl-600");
    const before = Date.now();

    const result = await setInferenceProfileSession({
      conversationId: conv.id,
      profile: "balanced",
      ttlSeconds: 600,
    });

    expect(result.conversationId).toBe(conv.id);
    expect(result.profile).toBe("balanced");
    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId).not.toBeNull();
    // UUID pattern
    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.expiresAt).not.toBeNull();
    expect(result.expiresAt!).toBeGreaterThanOrEqual(before + 600_000);
    expect(result.expiresAt!).toBeLessThanOrEqual(Date.now() + 600_000 + 1000);
    expect(result.ttlSeconds).toBe(600);
    expect(result.replaced).toBeNull();
  });

  test("open without ttlSeconds — sessionId=null, expiresAt=null (sticky)", async () => {
    const conv = createConversation("sess-handler-no-ttl");

    const result = await setInferenceProfileSession({
      conversationId: conv.id,
      profile: "balanced",
      // ttlSeconds intentionally absent (undefined)
    });

    expect(result.profile).toBe("balanced");
    expect(result.sessionId).toBeNull();
    expect(result.expiresAt).toBeNull();
    expect(result.ttlSeconds).toBeUndefined();
    expect(result.replaced).toBeNull();
  });

  test("open with ttlSeconds=99_999_999 — clamped to maxTtlSeconds (43200)", async () => {
    const conv = createConversation("sess-handler-clamp");
    const before = Date.now();

    const result = await setInferenceProfileSession({
      conversationId: conv.id,
      profile: "balanced",
      ttlSeconds: 99_999_999,
    });

    expect(result.ttlSeconds).toBe(43200);
    expect(result.expiresAt).not.toBeNull();
    expect(result.expiresAt!).toBeGreaterThanOrEqual(before + 43200 * 1000);
    expect(result.expiresAt!).toBeLessThanOrEqual(Date.now() + 43200 * 1000 + 1000);
  });

  test("open over active session — replaced carries prior session info", async () => {
    const conv = createConversation("sess-handler-replace");

    // Open first session
    const first = await setInferenceProfileSession({
      conversationId: conv.id,
      profile: "balanced",
      ttlSeconds: 300,
    });

    expect(first.replaced).toBeNull();

    // Open second session over the first
    const second = await setInferenceProfileSession({
      conversationId: conv.id,
      profile: "cost-optimized",
      ttlSeconds: 600,
    });

    expect(second.replaced).not.toBeNull();
    expect(second.replaced!.profile).toBe("balanced");
    expect(second.replaced!.sessionId).toBe(first.sessionId);
    expect(second.replaced!.expiresAt).toBe(first.expiresAt);
  });

  test("open with profile=null — all three cleared; replaced set if prior existed", async () => {
    const conv = createConversation("sess-handler-clear");

    // Set up an active session first
    const opened = await setInferenceProfileSession({
      conversationId: conv.id,
      profile: "balanced",
      ttlSeconds: 300,
    });

    // Now clear
    const cleared = await setInferenceProfileSession({
      conversationId: conv.id,
      profile: null,
    });

    expect(cleared.profile).toBeNull();
    expect(cleared.sessionId).toBeNull();
    expect(cleared.expiresAt).toBeNull();
    expect(cleared.replaced).not.toBeNull();
    expect(cleared.replaced!.profile).toBe("balanced");
    expect(cleared.replaced!.sessionId).toBe(opened.sessionId);

    // DB should reflect cleared state
    const row = getConversation(conv.id);
    expect(row?.inferenceProfile).toBeNull();
    expect(row?.inferenceProfileSessionId).toBeNull();
    expect(row?.inferenceProfileExpiresAt).toBeNull();
  });

  test("clear is idempotent — repeated clears on already-empty row do not write or publish", async () => {
    const conv = createConversation("sess-handler-clear-noop");

    // Sanity: the freshly-created row is fully clear.
    const before = getConversation(conv.id);
    expect(before?.inferenceProfile).toBeNull();
    expect(before?.inferenceProfileSessionId).toBeNull();
    expect(before?.inferenceProfileExpiresAt).toBeNull();
    const updatedAtBefore = before?.updatedAt;

    publishMock.mockClear();
    const result = await setInferenceProfileSession({
      conversationId: conv.id,
      profile: null,
    });

    // Returned shape matches a clear, with no replaced session.
    expect(result.profile).toBeNull();
    expect(result.sessionId).toBeNull();
    expect(result.expiresAt).toBeNull();
    expect(result.replaced).toBeNull();

    // No event was published — this is the load-bearing assertion for the
    // idempotency guard (Codex P2 on PR #29913).
    expect(publishMock).not.toHaveBeenCalled();

    // No DB write occurred — `updatedAt` is unchanged.
    const after = getConversation(conv.id);
    expect(after?.updatedAt).toBe(updatedAtBefore as number);
  });

  test("clear after sticky non-session override — still writes and publishes", async () => {
    const conv = createConversation("sess-handler-clear-sticky");

    // Open a sticky (no-TTL) override — sessionId stays null, expiresAt stays null,
    // but inferenceProfile is set. This is NOT the noop case.
    await setInferenceProfileSession({
      conversationId: conv.id,
      profile: "balanced",
      ttlSeconds: null,
    });

    publishMock.mockClear();
    const result = await setInferenceProfileSession({
      conversationId: conv.id,
      profile: null,
    });

    expect(result.profile).toBeNull();
    // No prior active SESSION (sessionId was null), so replaced is null even
    // though the sticky profile was cleared.
    expect(result.replaced).toBeNull();

    // The clear DID happen — DB row reflects it and an event was published.
    expect(publishMock).toHaveBeenCalledTimes(1);
    const row = getConversation(conv.id);
    expect(row?.inferenceProfile).toBeNull();
  });

  test("open with unknown profile — throws BadRequestError", async () => {
    const conv = createConversation("sess-handler-unknown-profile");

    await expect(
      setInferenceProfileSession({
        conversationId: conv.id,
        profile: "nonexistent-profile",
        ttlSeconds: 300,
      }),
    ).rejects.toThrow('Profile "nonexistent-profile" is not defined in llm.profiles');
  });

  test("open with ttlSeconds=null — expiresAt=null, sessionId=null, profile kept", async () => {
    const conv = createConversation("sess-handler-null-ttl");

    const result = await setInferenceProfileSession({
      conversationId: conv.id,
      profile: "balanced",
      ttlSeconds: null,
    });

    expect(result.profile).toBe("balanced");
    expect(result.sessionId).toBeNull();
    expect(result.expiresAt).toBeNull();
    expect(result.ttlSeconds).toBeNull();
    expect(result.replaced).toBeNull();
  });

  test("throws NotFoundError for unknown conversation id", async () => {
    await expect(
      setInferenceProfileSession({
        conversationId: "conv-does-not-exist",
        profile: "balanced",
      }),
    ).rejects.toThrow("not found");
  });

  test("caller-supplied sessionId is used when ttlSeconds is provided", async () => {
    const conv = createConversation("sess-handler-caller-session-id");
    const callerSessionId = "my-custom-session-id";

    const result = await setInferenceProfileSession({
      conversationId: conv.id,
      profile: "balanced",
      ttlSeconds: 300,
      sessionId: callerSessionId,
    });

    expect(result.sessionId).toBe(callerSessionId);
  });
});

describe("closeInferenceProfileSession", () => {
  beforeEach(() => {
    resetDb();
    mockProfiles = { balanced: {} };
    mockMaxTtl = undefined;
  });

  test("close — returns closed with profile and sessionId, noop=false", async () => {
    const conv = createConversation("sess-handler-close");

    const opened = await setInferenceProfileSession({
      conversationId: conv.id,
      profile: "balanced",
      ttlSeconds: 300,
    });

    const closed = await closeInferenceProfileSession(conv.id);

    expect(closed.conversationId).toBe(conv.id);
    expect(closed.noop).toBe(false);
    expect(closed.closed).not.toBeNull();
    expect(closed.closed!.profile).toBe("balanced");
    expect(closed.closed!.sessionId).toBe(opened.sessionId);
  });

  test("close with no active session — closed=null, noop=true", async () => {
    const conv = createConversation("sess-handler-close-noop");

    const result = await closeInferenceProfileSession(conv.id);

    expect(result.conversationId).toBe(conv.id);
    expect(result.noop).toBe(true);
    expect(result.closed).toBeNull();
  });

  test("close with sticky override (no sessionId) — noop=true, sticky override preserved", async () => {
    const conv = createConversation("sess-handler-close-sticky");

    // Set a sticky override (no ttlSeconds → sessionId=null)
    await setInferenceProfileSession({
      conversationId: conv.id,
      profile: "balanced",
    });

    expect(getConversation(conv.id)?.inferenceProfileSessionId).toBeNull();

    const result = await closeInferenceProfileSession(conv.id);

    expect(result.noop).toBe(true);
    expect(result.closed).toBeNull();
    // Sticky override must remain untouched
    expect(getConversation(conv.id)?.inferenceProfile).toBe("balanced");
  });
});

describe("listInferenceProfileSessionsWithRemaining", () => {
  beforeEach(() => {
    resetDb();
    mockProfiles = { balanced: {} };
    mockMaxTtl = undefined;
  });

  test("lists active sessions with remainingSeconds > 0", async () => {
    const conv = createConversation("sess-handler-list");

    await setInferenceProfileSession({
      conversationId: conv.id,
      profile: "balanced",
      ttlSeconds: 600,
    });

    const sessions = listInferenceProfileSessionsWithRemaining(conv.id);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].conversationId).toBe(conv.id);
    expect(sessions[0].profile).toBe("balanced");
    expect(sessions[0].remainingSeconds).toBeGreaterThan(0);
    expect(sessions[0].remainingSeconds).toBeLessThanOrEqual(600);
  });

  test("returns empty list when no active session exists", async () => {
    const conv = createConversation("sess-handler-list-empty");

    const sessions = listInferenceProfileSessionsWithRemaining(conv.id);

    expect(sessions).toHaveLength(0);
  });
});

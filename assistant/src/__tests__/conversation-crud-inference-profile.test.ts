import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import {
  createConversation,
  getConversation,
  getConversationOverrideProfileFromRow,
  setConversationInferenceProfile,
  setConversationInferenceProfileSession,
} from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
initializeDb();

describe("setConversationInferenceProfile", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test("round-trips null → name → null on the inferenceProfile column", async () => {
    const conv = createConversation("inference-profile-roundtrip");
    expect(getConversation(conv.id)?.inferenceProfile).toBeNull();

    await setConversationInferenceProfile(conv.id, "quality-optimized");
    expect(getConversation(conv.id)?.inferenceProfile).toBe(
      "quality-optimized",
    );

    await setConversationInferenceProfile(conv.id, null);
    expect(getConversation(conv.id)?.inferenceProfile).toBeNull();
  });

  test("does not throw when called with a valid conversation id", async () => {
    const conv = createConversation("inference-profile-no-throw");
    await setConversationInferenceProfile(conv.id, "balanced");
    await setConversationInferenceProfile(conv.id, null);
  });

  test("getConversation surfaces the column on every fetch", async () => {
    const conv = createConversation("inference-profile-getter");
    const fresh = getConversation(conv.id);
    expect(fresh).not.toBeNull();
    expect(fresh).toHaveProperty("inferenceProfile", null);

    await setConversationInferenceProfile(conv.id, "cost-optimized");
    const updated = getConversation(conv.id);
    expect(updated).toHaveProperty("inferenceProfile", "cost-optimized");
  });
});

describe("getConversationOverrideProfileFromRow — lazy expiry check", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test("returns undefined when inferenceProfileExpiresAt is in the past", () => {
    const conv = createConversation("inference-profile-expired");
    // Set a session-backed profile with an already-expired timestamp.
    setConversationInferenceProfileSession(
      conv.id,
      "balanced",
      "session-uuid-1",
      Date.now() - 1,
    );
    const row = getConversation(conv.id);
    expect(row).not.toBeNull();
    expect(getConversationOverrideProfileFromRow(row)).toBeUndefined();
  });

  test("returns the profile when inferenceProfileExpiresAt is in the future", () => {
    const conv = createConversation("inference-profile-active-session");
    setConversationInferenceProfileSession(
      conv.id,
      "balanced",
      "session-uuid-2",
      Date.now() + 60_000,
    );
    const row = getConversation(conv.id);
    expect(row).not.toBeNull();
    expect(getConversationOverrideProfileFromRow(row)).toBe("balanced");
  });

  test("returns undefined at the exact-expiry boundary (expiresAt === now)", () => {
    // Boundary consistency with the reaper SQL (`expires_at <= now`) and
    // the active-session queries (`expiresAt > now`): the lazy check must
    // treat `expiresAt === now` as expired, not active. Otherwise a
    // just-expired session would be served for one extra turn while the
    // reaper is racing to clear it.
    const conv = createConversation("inference-profile-boundary");
    const now = Date.now();
    setConversationInferenceProfileSession(
      conv.id,
      "balanced",
      "session-uuid-boundary",
      now,
    );
    const row = getConversation(conv.id);
    expect(row).not.toBeNull();
    expect(row?.inferenceProfileExpiresAt).toBe(now);
    // Freeze Date.now to the exact stored expiry so this is deterministic.
    const realNow = Date.now;
    Date.now = () => now;
    try {
      expect(getConversationOverrideProfileFromRow(row)).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });

  test("returns the profile when no expiry is set (non-session override)", () => {
    const conv = createConversation("inference-profile-no-expiry");
    setConversationInferenceProfileSession(
      conv.id,
      "quality-optimized",
      null,
      null,
    );
    const row = getConversation(conv.id);
    expect(row).not.toBeNull();
    expect(getConversationOverrideProfileFromRow(row)).toBe(
      "quality-optimized",
    );
  });

  test.each<"background" | "scheduled">(["background", "scheduled"])(
    "returns undefined for %s conversations even when a profile is pinned",
    (conversationType) => {
      const conv = createConversation({
        title: `inference-profile-${conversationType}`,
        conversationType,
      });
      setConversationInferenceProfileSession(
        conv.id,
        "quality-optimized",
        null,
        null,
      );
      const row = getConversation(conv.id);
      expect(row).not.toBeNull();
      expect(row?.conversationType).toBe(conversationType);
      expect(row?.inferenceProfile).toBe("quality-optimized");
      expect(getConversationOverrideProfileFromRow(row)).toBeUndefined();
    },
  );
});

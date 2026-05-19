import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { getSqlite, resetDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  getActivePerceptionConsent,
  hasActivePerceptionConsent,
  listPerceptionConsentGrantsForConversation,
  recordPerceptionConsentGrant,
  revokePerceptionConsentGrant,
} from "./consent-grants.js";

describe("perception consent grants", () => {
  beforeAll(() => {
    resetDb();
    initializeDb();
  });

  beforeEach(() => {
    const sqlite = getSqlite();
    sqlite.run("DELETE FROM perception_consent_grants");
  });

  test("no grant by default", () => {
    expect(
      hasActivePerceptionConsent({
        conversationId: "conv-1",
        eventKind: "screen_snapshot",
      }),
    ).toBe(false);
  });

  test("granted lookup returns the grant", () => {
    recordPerceptionConsentGrant({
      conversationId: "conv-1",
      eventKind: "audio_excerpt",
    });
    const grant = getActivePerceptionConsent({
      conversationId: "conv-1",
      eventKind: "audio_excerpt",
    });
    expect(grant?.eventKind).toBe("audio_excerpt");
    expect(grant?.conversationId).toBe("conv-1");
    expect(grant?.revokedAt).toBeNull();
  });

  test("expired grants are not active", () => {
    const past = Date.now() - 10_000;
    recordPerceptionConsentGrant({
      conversationId: "conv-1",
      eventKind: "screen_snapshot",
      expiresAt: past,
    });
    expect(
      hasActivePerceptionConsent({
        conversationId: "conv-1",
        eventKind: "screen_snapshot",
      }),
    ).toBe(false);
  });

  test("revocation makes grant inactive", () => {
    recordPerceptionConsentGrant({
      conversationId: "conv-1",
      eventKind: "screen_snapshot",
    });
    expect(
      hasActivePerceptionConsent({
        conversationId: "conv-1",
        eventKind: "screen_snapshot",
      }),
    ).toBe(true);

    const result = revokePerceptionConsentGrant({
      conversationId: "conv-1",
      eventKind: "screen_snapshot",
    });
    expect(result).toBe("active");
    expect(
      hasActivePerceptionConsent({
        conversationId: "conv-1",
        eventKind: "screen_snapshot",
      }),
    ).toBe(false);
  });

  test("repeated revocation returns already_revoked", () => {
    recordPerceptionConsentGrant({
      conversationId: "conv-1",
      eventKind: "audio_excerpt",
    });
    revokePerceptionConsentGrant({
      conversationId: "conv-1",
      eventKind: "audio_excerpt",
    });
    const result = revokePerceptionConsentGrant({
      conversationId: "conv-1",
      eventKind: "audio_excerpt",
    });
    expect(result).toBe("already_revoked");
  });

  test("revocation of unknown grant returns not_found", () => {
    const result = revokePerceptionConsentGrant({
      conversationId: "conv-2",
      eventKind: "screen_snapshot",
    });
    expect(result).toBe("not_found");
  });

  test("re-granting restores an active grant", () => {
    recordPerceptionConsentGrant({
      conversationId: "conv-1",
      eventKind: "screen_snapshot",
    });
    revokePerceptionConsentGrant({
      conversationId: "conv-1",
      eventKind: "screen_snapshot",
    });
    recordPerceptionConsentGrant({
      conversationId: "conv-1",
      eventKind: "screen_snapshot",
    });
    const grant = getActivePerceptionConsent({
      conversationId: "conv-1",
      eventKind: "screen_snapshot",
    });
    expect(grant).not.toBeNull();
    expect(grant?.revokedAt).toBeNull();
  });

  test("grants are scoped per (conversation, eventKind)", () => {
    recordPerceptionConsentGrant({
      conversationId: "conv-A",
      eventKind: "screen_snapshot",
    });
    expect(
      hasActivePerceptionConsent({
        conversationId: "conv-A",
        eventKind: "screen_snapshot",
      }),
    ).toBe(true);
    expect(
      hasActivePerceptionConsent({
        conversationId: "conv-A",
        eventKind: "audio_excerpt",
      }),
    ).toBe(false);
    expect(
      hasActivePerceptionConsent({
        conversationId: "conv-B",
        eventKind: "screen_snapshot",
      }),
    ).toBe(false);
  });

  test("listGrantsForConversation returns the conversation's grants", () => {
    recordPerceptionConsentGrant({
      conversationId: "conv-1",
      eventKind: "screen_snapshot",
    });
    recordPerceptionConsentGrant({
      conversationId: "conv-1",
      eventKind: "audio_excerpt",
    });
    const grants = listPerceptionConsentGrantsForConversation("conv-1");
    expect(grants).toHaveLength(2);
    expect(grants.map((g) => g.eventKind).sort()).toEqual([
      "audio_excerpt",
      "screen_snapshot",
    ]);
  });
});

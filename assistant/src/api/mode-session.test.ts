import { describe, expect, test } from "bun:test";

import {
  ModeSessionSchema,
  ModeSessionStatusSchema,
  ModeSessionSummarySchema,
} from "./mode-session.js";

describe("mode session API schemas", () => {
  test("accepts canonical membership", () => {
    expect(
      ModeSessionSchema.parse({ id: "session-123", mode: "browser" }),
    ).toEqual({ id: "session-123", mode: "browser" });
  });

  test("keeps persisted status to the three lifecycle states", () => {
    expect(ModeSessionStatusSchema.options).toEqual([
      "active",
      "completed",
      "interrupted",
    ]);
    expect(ModeSessionStatusSchema.safeParse("waiting").success).toBe(false);
    expect(ModeSessionStatusSchema.safeParse("draining").success).toBe(false);
  });

  test("accepts an interrupted summary with unknown end time", () => {
    const summary = ModeSessionSummarySchema.parse({
      id: "session-123",
      conversationId: "conv-123",
      mode: "computer_use",
      status: "interrupted",
      sourceStartedAt: 100,
      firstIncludedAt: 110,
      firstIncludedMessageId: "message-123",
      lastActivityAt: 125,
      lastOwnedMessageId: "message-456",
      endedAt: null,
      endReason: "assistant_restarted",
      revision: 4,
    });

    expect(summary.endedAt).toBeNull();
  });

  test("rejects unknown historic modes and invalid revisions", () => {
    const base = {
      id: "session-123",
      conversationId: "conv-123",
      status: "active",
      sourceStartedAt: 100,
      firstIncludedAt: null,
      firstIncludedMessageId: null,
      lastActivityAt: 100,
      lastOwnedMessageId: null,
      endedAt: null,
      endReason: null,
    };
    expect(
      ModeSessionSummarySchema.safeParse({
        ...base,
        mode: "unknown_mode",
        revision: 1,
      }).success,
    ).toBe(false);
    expect(
      ModeSessionSummarySchema.safeParse({
        ...base,
        mode: "ambient",
        revision: 0,
      }).success,
    ).toBe(false);
  });

  test("enforces status-specific terminal timing", () => {
    const base = {
      id: "session-123",
      conversationId: "conv-123",
      mode: "browser",
      sourceStartedAt: 100,
      firstIncludedAt: null,
      firstIncludedMessageId: null,
      lastActivityAt: 125,
      lastOwnedMessageId: null,
      revision: 1,
    };

    expect(
      ModeSessionSummarySchema.safeParse({
        ...base,
        status: "active",
        endedAt: 150,
        endReason: "settled",
      }).success,
    ).toBe(false);
    expect(
      ModeSessionSummarySchema.safeParse({
        ...base,
        status: "completed",
        endedAt: null,
        endReason: "settled",
      }).success,
    ).toBe(false);
    expect(
      ModeSessionSummarySchema.safeParse({
        ...base,
        status: "completed",
        endedAt: 120,
        endReason: "settled",
      }).success,
    ).toBe(false);
  });

  test("keeps display boundary fields paired", () => {
    expect(
      ModeSessionSummarySchema.safeParse({
        id: "session-123",
        conversationId: "conv-123",
        mode: "ambient",
        status: "active",
        sourceStartedAt: 100,
        firstIncludedAt: 110,
        firstIncludedMessageId: null,
        lastActivityAt: 125,
        lastOwnedMessageId: null,
        endedAt: null,
        endReason: null,
        revision: 1,
      }).success,
    ).toBe(false);
  });
});

/**
 * Focused tests for conversation candidate building and prompt serialization.
 *
 * Validates that the candidate builder produces correct, lightweight metadata
 * and that the prompt serializer formats it in a token-efficient way.
 */

import { describe, expect, test } from "bun:test";

import type {
  ConversationCandidate,
  ConversationCandidateSet,
} from "../notifications/conversation-candidates.js";
import { serializeCandidatesForPrompt } from "../notifications/conversation-candidates.js";
import type { NotificationChannel } from "../notifications/types.js";

// -- serializeCandidatesForPrompt tests ---------------------------------------

describe("serializeCandidatesForPrompt", () => {
  test("returns null for empty candidate set", () => {
    expect(serializeCandidatesForPrompt({})).toBeNull();
  });

  test("returns null when all channels have empty arrays", () => {
    const set: ConversationCandidateSet = { vellum: [] };
    expect(serializeCandidatesForPrompt(set)).toBeNull();
  });

  test("serializes a single channel with one candidate", () => {
    const set: ConversationCandidateSet = {
      vellum: [
        {
          conversationId: "conv-001",
          title: "Reminder thread",
          updatedAt: 1700000000000,
          latestSourceEventName: "schedule.notify",
          channel: "vellum" as NotificationChannel,
        },
      ],
    };

    const result = serializeCandidatesForPrompt(set);
    expect(result).not.toBeNull();
    expect(result).toContain("Channel: vellum");
    expect(result).toContain("id=conv-001");
    expect(result).toContain('title="Reminder thread"');
    expect(result).toContain('lastEvent="schedule.notify"');
  });

  test("serializes untitled conversations with placeholder", () => {
    const set: ConversationCandidateSet = {
      vellum: [
        {
          conversationId: "conv-002",
          title: null,
          updatedAt: 1700000000000,
          latestSourceEventName: null,
          channel: "vellum" as NotificationChannel,
        },
      ],
    };

    const result = serializeCandidatesForPrompt(set)!;
    expect(result).toContain('title="(untitled)"');
    expect(result).not.toContain("lastEvent=");
  });

  test("includes guardian context when present", () => {
    const set: ConversationCandidateSet = {
      vellum: [
        {
          conversationId: "conv-003",
          title: "Guardian thread",
          updatedAt: 1700000000000,
          latestSourceEventName: "guardian.question",
          channel: "vellum" as NotificationChannel,
          guardianContext: { pendingUnresolvedRequestCount: 3 },
        },
      ],
    };

    const result = serializeCandidatesForPrompt(set)!;
    expect(result).toContain("pendingRequests=3");
  });

  test("serializes multiple channels", () => {
    const set: ConversationCandidateSet = {
      vellum: [
        {
          conversationId: "conv-001",
          title: "Vellum thread",
          updatedAt: 1700000000000,
          latestSourceEventName: "schedule.notify",
          channel: "vellum" as NotificationChannel,
        },
      ],
      telegram: [
        {
          conversationId: "conv-002",
          title: "Telegram thread",
          updatedAt: 1700000000000,
          latestSourceEventName: "guardian.question",
          channel: "telegram" as NotificationChannel,
        },
      ],
    };

    const result = serializeCandidatesForPrompt(set)!;
    expect(result).toContain("Channel: vellum");
    expect(result).toContain("Channel: telegram");
    expect(result).toContain("id=conv-001");
    expect(result).toContain("id=conv-002");
  });

  test("serializes multiple candidates per channel", () => {
    const set: ConversationCandidateSet = {
      vellum: [
        {
          conversationId: "conv-001",
          title: "First thread",
          updatedAt: 1700000000000,
          latestSourceEventName: "schedule.notify",
          channel: "vellum" as NotificationChannel,
        },
        {
          conversationId: "conv-002",
          title: "Second thread",
          updatedAt: 1699999000000,
          latestSourceEventName: "guardian.question",
          channel: "vellum" as NotificationChannel,
          guardianContext: { pendingUnresolvedRequestCount: 1 },
        },
      ],
    };

    const result = serializeCandidatesForPrompt(set)!;
    expect(result).toContain("id=conv-001");
    expect(result).toContain("id=conv-002");
    expect(result).toContain("pendingRequests=1");
  });
});

// -- ConversationCandidate type correctness -----------------------------------------

describe("ConversationCandidate type", () => {
  test("candidate has all required fields", () => {
    const candidate: ConversationCandidate = {
      conversationId: "conv-test",
      title: "Test",
      updatedAt: Date.now(),
      latestSourceEventName: "test.event",
      channel: "vellum" as NotificationChannel,
    };
    expect(candidate.conversationId).toBe("conv-test");
    expect(candidate.guardianContext).toBeUndefined();
  });

  test("candidate can include guardian context", () => {
    const candidate: ConversationCandidate = {
      conversationId: "conv-test",
      title: "Test",
      updatedAt: Date.now(),
      latestSourceEventName: "guardian.question",
      channel: "vellum" as NotificationChannel,
      guardianContext: { pendingUnresolvedRequestCount: 5 },
    };
    expect(candidate.guardianContext?.pendingUnresolvedRequestCount).toBe(5);
  });
});

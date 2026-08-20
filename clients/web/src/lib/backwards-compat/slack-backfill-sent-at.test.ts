import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import type { DisplayMessage } from "@/domains/chat/types/types";
import {
  slackOriginTimestamp,
  useSupportsBackfilledSentAt,
} from "@/lib/backwards-compat/slack-backfill-sent-at";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

/** Read the gate synchronously through the exported hook. */
function readGate(version: string | null): boolean {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
  return renderHook(() => useSupportsBackfilledSentAt()).result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

function slackMessage(
  slack: NonNullable<DisplayMessage["slackMessage"]>,
): DisplayMessage {
  return { id: "m1", role: "user", slackMessage: slack };
}

// Exhaustive semver truth-table lives in `utils.test.ts`; this covers the
// boundary on each side of 0.11.5 plus the conservative-on-unknown policy.
describe("useSupportsBackfilledSentAt", () => {
  test("false when the version is unknown", () => {
    expect(readGate(null)).toBe(false);
  });

  test("false below the pinned version, where sentAt is not sent", () => {
    expect(readGate("0.11.4")).toBe(false);
  });

  test("true from the pinned version on", () => {
    expect(readGate("0.11.5")).toBe(true);
    expect(readGate("0.12.0")).toBe(true);
  });
});

describe("slackOriginTimestamp", () => {
  test("recovers the send time from the Slack ts", () => {
    const sentAt = Date.UTC(2026, 6, 8, 9, 15);
    expect(
      slackOriginTimestamp(
        slackMessage({ channelId: "D1", channelTs: String(sentAt / 1000) }),
      ),
    ).toBe(sentAt);
  });

  test("ignores reaction rows, whose ts belongs to the reacted message", () => {
    const reactedAt = Date.UTC(2026, 6, 8, 9, 15);
    expect(
      slackOriginTimestamp(
        slackMessage({
          channelId: "D1",
          channelTs: String(reactedAt / 1000),
          eventKind: "reaction",
          reaction: {
            emoji: "eyes",
            op: "added",
            targetChannelTs: String(reactedAt / 1000),
          },
        }),
      ),
    ).toBeUndefined();
  });

  test("rejects a partially numeric ts rather than inventing a time", () => {
    expect(
      slackOriginTimestamp(
        slackMessage({ channelId: "D1", channelTs: "1783514100.123junk" }),
      ),
    ).toBeUndefined();
  });

  test("returns undefined for a non-Slack row", () => {
    expect(slackOriginTimestamp({ id: "m1", role: "user" })).toBeUndefined();
  });
});

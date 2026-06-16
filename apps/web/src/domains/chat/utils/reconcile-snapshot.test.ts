import { describe, expect, test } from "bun:test";

const { reconcileSnapshot } = await import("@/domains/chat/utils/reconcile-snapshot");

const { makeServerMessage, messageText, textBody, wireTextBody, wireTimestamp } =
  await import("@/domains/chat/utils/message-test-helpers");

import type { DisplayMessage } from "@/domains/chat/types/types";

function makeLocal(
  overrides: Omit<DisplayMessage, "id"> & { id?: string },
): DisplayMessage {
  const { id, ...rest } = overrides;
  return { id: id ?? crypto.randomUUID(), ...rest };
}

describe("reconcileSnapshot", () => {
  test("keeps local content when the stream is ahead of the snapshot", () => {
    /**
     * The seq-aware merge runs, so a stale snapshot cannot regress the
     * streamed answer.
     */
    // GIVEN the stream has carried the conversation to frontier 10
    const local = [
      makeLocal({ id: "a1", role: "assistant", ...textBody("AAA"), timestamp: 1000 }),
    ];
    const server = [
      makeServerMessage({
        id: "a1",
        role: "assistant",
        ...wireTextBody("BBB"),
        timestamp: wireTimestamp(1000),
      }),
    ];

    // WHEN a snapshot at watermark 5 (behind the frontier) is reconciled
    const result = reconcileSnapshot(local, server, {
      serverSeq: 5,
      localSeq: 10,
    });

    // THEN the streamed local content is kept
    expect(messageText(result[0])).toBe("AAA");
  });

  test("takes the snapshot authoritatively when the reconnect flag is set", () => {
    /**
     * On a reconnect the live frontier can overstate what was applied (events
     * evicted from the daemon's replay ring left a hole), so the `authoritative`
     * flag makes the snapshot win even though it sits behind the frontier —
     * healing the transcript instead of preserving the holey local rows.
     */
    // GIVEN the stream has carried the conversation to frontier 10
    const local = [
      makeLocal({ id: "a1", role: "assistant", ...textBody("AAA"), timestamp: 1000 }),
    ];
    const server = [
      makeServerMessage({
        id: "a1",
        role: "assistant",
        ...wireTextBody("BBB"),
        timestamp: wireTimestamp(1000),
      }),
    ];

    // WHEN a snapshot behind the frontier is reconciled authoritatively
    const result = reconcileSnapshot(local, server, {
      serverSeq: 5,
      localSeq: 10,
      authoritative: true,
    });

    // THEN the snapshot content wins
    expect(messageText(result[0])).toBe("BBB");
  });
});

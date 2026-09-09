/**
 * Tests for `useConversationAttachments` on its transcript path.
 *
 * The rows are seeded into the chat-session store in the shape the store
 * itself holds, so the hook runs its real subscription: what is asserted here
 * is the walk over those rows, and that a streaming turn does not disturb it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { makeDisplayAttachment } from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import {
  clearTranscriptMessages,
  clearTranscriptOwner,
  seedTranscriptMessages,
} from "@/domains/chat/components/chat-info.test-helper";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import {
  countEntryTotals,
  useConversationAttachments,
} from "@/domains/chat/hooks/use-conversation-attachments";
import type { DisplayMessage } from "@/domains/chat/types/types";

const TARGET = { assistantId: "asst-1", conversationId: "conv-1" };

function makeMessage(overrides: Partial<DisplayMessage>): DisplayMessage {
  return { id: "msg-1", role: "user", ...overrides };
}

/** Seeds `messages` as the transcript the target conversation owns. */
function seed(messages: DisplayMessage[]): void {
  seedTranscriptMessages(TARGET.assistantId, TARGET.conversationId, messages);
}

beforeEach(() => {
  seed([]);
});

afterEach(() => {
  cleanup();
  clearTranscriptMessages();
});

describe("useConversationAttachments", () => {
  test("walks the transcript newest first", () => {
    seed([
      makeMessage({
        id: "msg-1",
        timestamp: 1_000,
        attachments: [makeDisplayAttachment({ id: "old" })],
      }),
      makeMessage({
        id: "msg-2",
        timestamp: 2_000,
        attachments: [makeDisplayAttachment({ id: "new" })],
      }),
    ]);

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries.map((entry) => entry.attachment.id)).toEqual([
      "new",
      "old",
    ]);
    expect(result.current.entries[0]).toMatchObject({
      key: "new",
      capturedAt: 2_000,
      sightFrame: false,
    });
    expect(result.current.source).toBe("transcript");
    expect(result.current.totalFiles).toBe(2);
    expect(result.current.totalFrames).toBe(0);
    expect(result.current.hasMoreFiles).toBe(false);
    expect(result.current.hasMoreFrames).toBe(false);
  });

  test("lists an optimistic send's files alongside the snapshot's", () => {
    seed([
      makeMessage({
        id: "msg-sent",
        timestamp: 1_000,
        attachments: [makeDisplayAttachment({ id: "sent" })],
      }),
    ]);
    useChatSessionStore.setState({
      optimisticSends: [
        makeMessage({
          id: "msg-sending",
          timestamp: 2_000,
          attachments: [makeDisplayAttachment({ id: "sending" })],
        }),
      ],
    });

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries.map((entry) => entry.attachment.id)).toEqual([
      "sending",
      "sent",
    ]);
  });

  test("collapses an attachment carried by two rows", () => {
    // An optimistic send and its confirmed echo carry the same attachment.
    const attachment = makeDisplayAttachment({ id: "shared" });
    seed([
      makeMessage({
        id: "msg-echo",
        timestamp: 1_000,
        attachments: [attachment],
      }),
      makeMessage({
        id: "msg-optimistic",
        timestamp: 2_000,
        attachments: [attachment],
      }),
    ]);

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries).toHaveLength(1);
    // The newer row's timestamp: the first sighting of a shared id wins.
    expect(result.current.entries[0]!.capturedAt).toBe(2_000);
    expect(result.current.totalFiles).toBe(1);
  });

  test("keeps legacy rehydrated ids from different rows apart", () => {
    // Rows reloaded without structured metadata synthesize ids per message.
    seed([
      makeMessage({
        id: "msg-old",
        timestamp: 1_000,
        attachments: [
          makeDisplayAttachment({ id: "rehydrated:0", filename: "old.pdf" }),
        ],
      }),
      makeMessage({
        id: "msg-new",
        timestamp: 2_000,
        attachments: [
          makeDisplayAttachment({ id: "rehydrated:0", filename: "new.pdf" }),
        ],
      }),
    ]);

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries.map((entry) => entry.key)).toEqual([
      "msg-new:0",
      "msg-old:0",
    ]);
    expect(result.current.totalFiles).toBe(2);
  });

  test("keeps two rehydrated ids inside one folded row apart", () => {
    // Adjacent assistant rows fold across a page boundary and concatenate
    // their attachments under one message id.
    seed([
      makeMessage({
        id: "msg-folded",
        role: "assistant",
        mergedMessageIds: ["msg-donor"],
        attachments: [
          makeDisplayAttachment({ id: "rehydrated:0", filename: "a.pdf" }),
          makeDisplayAttachment({ id: "rehydrated:0", filename: "b.pdf" }),
        ],
      }),
    ]);

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries).toHaveLength(2);
    expect(new Set(result.current.entries.map((entry) => entry.key)).size).toBe(
      2,
    );
    // The donor's file was appended last, so it is the newer of the two.
    expect(
      result.current.entries.map((entry) => entry.attachment.filename),
    ).toEqual(["b.pdf", "a.pdf"]);
  });

  test("keeps one row's uploads in the order they were sent", () => {
    seed([
      makeMessage({
        id: "msg-upload",
        attachments: [
          makeDisplayAttachment({ id: "first", filename: "first.pdf" }),
          makeDisplayAttachment({ id: "second", filename: "second.pdf" }),
        ],
      }),
    ]);

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(
      result.current.entries.map((entry) => entry.attachment.filename),
    ).toEqual(["first.pdf", "second.pdf"]);
  });

  test("skips a channel-deleted row's files", () => {
    seed([
      makeMessage({
        id: "msg-gone",
        deletedAt: 3_000,
        attachments: [
          makeDisplayAttachment({ id: "gone", filename: "gone.pdf" }),
        ],
      }),
      makeMessage({
        id: "msg-kept",
        attachments: [
          makeDisplayAttachment({ id: "kept", filename: "kept.pdf" }),
        ],
      }),
    ]);

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries.map((entry) => entry.attachment.id)).toEqual([
      "kept",
    ]);
  });

  test("reports a null capture time for a row with no timestamp", () => {
    seed([
      makeMessage({ attachments: [makeDisplayAttachment({ id: "att-1" })] }),
    ]);

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries[0]!.capturedAt).toBeNull();
  });

  test("hands back the same empty array across renders", () => {
    seed([makeMessage({})]);

    const { result, rerender } = renderHook(() =>
      useConversationAttachments(TARGET),
    );
    const first = result.current.entries;
    rerender();

    expect(result.current.entries).toHaveLength(0);
    expect(result.current.entries).toBe(first);
  });

  // The header trigger mounts for the whole session, so a turn's token batches
  // must not reach it: the hook subscribes to the attachment-carrying rows, and
  // a text-only update leaves those shallow-equal.
  test("holds its entries through a text-only stream update", () => {
    seed([
      makeMessage({
        id: "msg-upload",
        timestamp: 1_000,
        attachments: [makeDisplayAttachment({ id: "att-1" })],
      }),
      makeMessage({ id: "msg-reply", role: "assistant", timestamp: 2_000 }),
    ]);

    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useConversationAttachments(TARGET);
    });
    const first = result.current.entries;
    const rendersAfterMount = renders;

    // A token batch re-mints the snapshot's `messages` array and the streaming
    // row inside it, and leaves every settled row alone.
    act(() => {
      useChatSessionStore
        .getState()
        .patchSnapshotMessages((prev) => [
          ...prev.slice(0, -1),
          { ...prev.at(-1)!, textSegments: ["still thinking"] },
        ]);
    });

    expect(result.current.entries).toBe(first);
    expect(renders).toBe(rendersAfterMount);
  });

  test("lists the loaded transcript when the target owns the snapshot", () => {
    seed([
      makeMessage({ attachments: [makeDisplayAttachment({ id: "mine" })] }),
    ]);

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries.map((entry) => entry.attachment.id)).toEqual([
      "mine",
    ]);
  });

  test("lists nothing when another conversation owns the snapshot", () => {
    seedTranscriptMessages(TARGET.assistantId, "conv-2", [
      makeMessage({ attachments: [makeDisplayAttachment({ id: "theirs" })] }),
    ]);

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries).toHaveLength(0);
    expect(result.current.totalFiles).toBe(0);
  });

  test("lists nothing when another assistant owns the snapshot", () => {
    seedTranscriptMessages("asst-2", TARGET.conversationId, [
      makeMessage({ attachments: [makeDisplayAttachment({ id: "theirs" })] }),
    ]);

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries).toHaveLength(0);
    expect(result.current.totalFiles).toBe(0);
  });

  test("lists nothing when no conversation owns the snapshot", () => {
    seed([
      makeMessage({ attachments: [makeDisplayAttachment({ id: "draft" })] }),
    ]);
    clearTranscriptOwner();

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries).toHaveLength(0);
    expect(result.current.totalFiles).toBe(0);
  });

  test("keeps the load-more callbacks stable", () => {
    const { result, rerender } = renderHook(() =>
      useConversationAttachments(TARGET),
    );
    const { loadMoreFiles, loadMoreFrames } = result.current;
    rerender();

    expect(result.current.loadMoreFiles).toBe(loadMoreFiles);
    expect(result.current.loadMoreFrames).toBe(loadMoreFrames);
  });
});

describe("countEntryTotals", () => {
  // The transcript cannot produce a frame, so the split is asserted directly:
  // it is what keeps the daemon path from counting one capture twice.
  test("counts a camera frame as a frame and not as a file", () => {
    const entry = (key: string, sightFrame: boolean) => ({
      key,
      attachment: makeDisplayAttachment({ id: key }),
      capturedAt: null,
      sightFrame,
    });

    expect(
      countEntryTotals([entry("a", false), entry("b", true), entry("c", true)]),
    ).toEqual({ totalFiles: 1, totalFrames: 2 });
  });

  test("counts nothing for no entries", () => {
    expect(countEntryTotals([])).toEqual({ totalFiles: 0, totalFrames: 0 });
  });
});

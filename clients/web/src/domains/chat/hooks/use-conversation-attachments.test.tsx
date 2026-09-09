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
  makeTranscriptRow,
  seedTranscriptMessages,
} from "@/domains/chat/components/chat-info.test-helper";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useConversationAttachments } from "@/domains/chat/hooks/use-conversation-attachments";
import type { DisplayMessage } from "@/domains/chat/types/types";

const TARGET = { assistantId: "asst-1", conversationId: "conv-1" };

/** Seeds `messages` as the transcript the target conversation owns. */
function seed(messages: DisplayMessage[]): void {
  seedTranscriptMessages(TARGET.assistantId, TARGET.conversationId, messages);
}

/** The target owns the transcript, with no snapshot and history `loading`. */
function ownWithoutSnapshot(loading: boolean): void {
  useChatSessionStore.setState({
    snapshot: null,
    optimisticSends: [],
    previousAssistantId: TARGET.assistantId,
    previousConversationId: TARGET.conversationId,
    isLoadingHistory: loading,
  });
}

beforeEach(() => {
  seed([]);
});

afterEach(() => {
  cleanup();
  clearTranscriptMessages();
  // The store is a module singleton, so its loading flag goes back to the
  // value a fresh chat session starts on.
  useChatSessionStore.setState({ isLoadingHistory: true });
});

describe("useConversationAttachments", () => {
  test("walks the transcript newest first", () => {
    seed([
      makeTranscriptRow({
        id: "msg-1",
        timestamp: 1_000,
        attachments: [makeDisplayAttachment({ id: "old" })],
      }),
      makeTranscriptRow({
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
    // The transcript never carries the frame tag, so this source has none.
    expect(result.current.totalFrames).toBe(0);
    expect(result.current.transcriptSettled).toBe(true);
    expect(result.current.hasMoreFiles).toBe(false);
    expect(result.current.hasMoreFrames).toBe(false);
  });

  test("lists an optimistic send's files alongside the snapshot's", () => {
    seed([
      makeTranscriptRow({
        id: "msg-sent",
        timestamp: 1_000,
        attachments: [makeDisplayAttachment({ id: "sent" })],
      }),
    ]);
    useChatSessionStore.setState({
      optimisticSends: [
        makeTranscriptRow({
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
      makeTranscriptRow({
        id: "msg-echo",
        timestamp: 1_000,
        attachments: [attachment],
      }),
      makeTranscriptRow({
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
      makeTranscriptRow({
        id: "msg-old",
        timestamp: 1_000,
        attachments: [
          makeDisplayAttachment({ id: "rehydrated:0", filename: "old.pdf" }),
        ],
      }),
      makeTranscriptRow({
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
    // A row carrying `mergedMessageIds` is walked like any other: the field is
    // stamped for stream-id reconciliation too, so it cannot mark a row whose
    // attachments were concatenated.
    seed([
      makeTranscriptRow({
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
    expect(
      result.current.entries.map((entry) => entry.attachment.filename),
    ).toEqual(["a.pdf", "b.pdf"]);
  });

  test("keeps one row's uploads in the order they were sent", () => {
    seed([
      makeTranscriptRow({
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
      makeTranscriptRow({
        id: "msg-gone",
        deletedAt: 3_000,
        attachments: [
          makeDisplayAttachment({ id: "gone", filename: "gone.pdf" }),
        ],
      }),
      makeTranscriptRow({
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
      makeTranscriptRow({
        attachments: [makeDisplayAttachment({ id: "att-1" })],
      }),
    ]);

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries[0]!.capturedAt).toBeNull();
  });

  test("hands back the same empty array across renders", () => {
    seed([makeTranscriptRow({})]);

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
      makeTranscriptRow({
        id: "msg-upload",
        timestamp: 1_000,
        attachments: [makeDisplayAttachment({ id: "att-1" })],
      }),
      makeTranscriptRow({
        id: "msg-reply",
        role: "assistant",
        timestamp: 2_000,
      }),
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

  // The other half of the same contract: the walk does run, once, when the set
  // of attachment-carrying rows actually changes.
  test("walks once when an attachment row lands", () => {
    seed([
      makeTranscriptRow({
        id: "msg-upload",
        timestamp: 1_000,
        attachments: [makeDisplayAttachment({ id: "att-1" })],
      }),
    ]);

    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useConversationAttachments(TARGET);
    });
    const first = result.current.entries;
    const rendersAfterMount = renders;

    act(() => {
      useChatSessionStore.getState().patchSnapshotMessages((prev) => [
        ...prev,
        makeTranscriptRow({
          id: "msg-second",
          timestamp: 2_000,
          attachments: [makeDisplayAttachment({ id: "att-2" })],
        }),
      ]);
    });

    expect(result.current.entries).not.toBe(first);
    expect(result.current.entries.map((entry) => entry.attachment.id)).toEqual([
      "att-2",
      "att-1",
    ]);
    expect(renders).toBe(rendersAfterMount + 1);
  });

  test("lists the loaded transcript when the target owns the snapshot", () => {
    seed([
      makeTranscriptRow({
        attachments: [makeDisplayAttachment({ id: "mine" })],
      }),
    ]);

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries.map((entry) => entry.attachment.id)).toEqual([
      "mine",
    ]);
  });

  test("lists nothing when another conversation owns the snapshot", () => {
    seedTranscriptMessages(TARGET.assistantId, "conv-2", [
      makeTranscriptRow({
        attachments: [makeDisplayAttachment({ id: "theirs" })],
      }),
    ]);

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries).toHaveLength(0);
    expect(result.current.totalFiles).toBe(0);
    expect(result.current.transcriptSettled).toBe(false);
  });

  test("lists nothing when another assistant owns the snapshot", () => {
    seedTranscriptMessages("asst-2", TARGET.conversationId, [
      makeTranscriptRow({
        attachments: [makeDisplayAttachment({ id: "theirs" })],
      }),
    ]);

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries).toHaveLength(0);
    expect(result.current.totalFiles).toBe(0);
  });

  test("lists nothing when no conversation owns the snapshot", () => {
    seed([
      makeTranscriptRow({
        attachments: [makeDisplayAttachment({ id: "draft" })],
      }),
    ]);
    clearTranscriptOwner();

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries).toHaveLength(0);
    expect(result.current.totalFiles).toBe(0);
    expect(result.current.transcriptSettled).toBe(false);
  });

  // An owned conversation with no snapshot yet is the first paint of a chat:
  // no files listed, and not yet the same thing as a chat with none.
  test("is unsettled while the history load is in flight", () => {
    ownWithoutSnapshot(true);

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.transcriptSettled).toBe(false);
    expect(result.current.entries).toHaveLength(0);
  });

  // A history load that failed sets the flag down and leaves the snapshot
  // null, and no later load is coming: waiting on a snapshot here would keep
  // the caller unsettled for the rest of the session.
  test("settles once a failed history load is over", () => {
    ownWithoutSnapshot(false);

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.transcriptSettled).toBe(true);
    expect(result.current.entries).toHaveLength(0);
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

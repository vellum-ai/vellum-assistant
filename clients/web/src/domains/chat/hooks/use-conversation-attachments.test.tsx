/**
 * Tests for `useConversationAttachments` on its transcript path.
 *
 * The transcript hook is mocked so a test states the rendered rows directly;
 * everything asserted here is the walk over those rows.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import type * as TranscriptMessages from "@/domains/chat/transcript/use-transcript-messages";
import type { DisplayMessage } from "@/domains/chat/types/types";

const messagesRef: { value: DisplayMessage[] } = { value: [] };

mock.module(
  "@/domains/chat/transcript/use-transcript-messages",
  (): Partial<typeof TranscriptMessages> => ({
    // A fresh array each render, the way the real selector behaves when the
    // snapshot churns, so the memo is actually exercised.
    useTranscriptMessages: () => [...messagesRef.value],
  }),
);

const { useConversationAttachments } =
  await import("@/domains/chat/hooks/use-conversation-attachments");
const { clearTranscriptOwner, seedTranscriptOwner } =
  await import("@/domains/chat/components/chat-info.test-helper");
const { makeDisplayAttachment } =
  await import("@/domains/chat/components/chat-attachments/attachment-fixtures");

const TARGET = { assistantId: "asst-1", conversationId: "conv-1" };

function makeMessage(overrides: Partial<DisplayMessage>): DisplayMessage {
  return { id: "msg-1", role: "user", ...overrides };
}

beforeEach(() => {
  seedTranscriptOwner(TARGET.assistantId, TARGET.conversationId);
});

afterEach(() => {
  cleanup();
  messagesRef.value = [];
  clearTranscriptOwner();
});

afterAll(() => {
  mock.restore();
});

describe("useConversationAttachments", () => {
  test("walks the transcript newest first", () => {
    messagesRef.value = [
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
    ];

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries.map((entry) => entry.attachment.id)).toEqual([
      "new",
      "old",
    ]);
    expect(result.current.entries[0]).toMatchObject({
      messageId: "msg-2",
      capturedAt: 2_000,
      sightFrame: false,
    });
    expect(result.current.source).toBe("transcript");
    expect(result.current.totalFiles).toBe(2);
    expect(result.current.totalFrames).toBe(0);
    expect(result.current.hasMoreFiles).toBe(false);
    expect(result.current.hasMoreFrames).toBe(false);
  });

  test("collapses an attachment carried by two rows", () => {
    // An optimistic send and its confirmed echo carry the same attachment.
    const attachment = makeDisplayAttachment({ id: "shared" });
    messagesRef.value = [
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
    ];

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]!.messageId).toBe("msg-optimistic");
    expect(result.current.totalFiles).toBe(1);
  });

  test("keeps legacy rehydrated ids from different rows apart", () => {
    // Rows reloaded without structured metadata synthesize ids per message.
    messagesRef.value = [
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
    ];

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries.map((entry) => entry.messageId)).toEqual([
      "msg-new",
      "msg-old",
    ]);
    expect(result.current.totalFiles).toBe(2);
  });

  test("keeps two rehydrated ids inside one folded row apart", () => {
    // Adjacent assistant rows fold across a page boundary and concatenate
    // their attachments under one message id.
    messagesRef.value = [
      makeMessage({
        id: "msg-folded",
        role: "assistant",
        mergedMessageIds: ["msg-donor"],
        attachments: [
          makeDisplayAttachment({ id: "rehydrated:0", filename: "a.pdf" }),
          makeDisplayAttachment({ id: "rehydrated:0", filename: "b.pdf" }),
        ],
      }),
    ];

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
    messagesRef.value = [
      makeMessage({
        id: "msg-upload",
        attachments: [
          makeDisplayAttachment({ id: "first", filename: "first.pdf" }),
          makeDisplayAttachment({ id: "second", filename: "second.pdf" }),
        ],
      }),
    ];

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(
      result.current.entries.map((entry) => entry.attachment.filename),
    ).toEqual(["first.pdf", "second.pdf"]);
  });

  test("skips a channel-deleted row's files", () => {
    messagesRef.value = [
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
    ];

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries.map((entry) => entry.attachment.id)).toEqual([
      "kept",
    ]);
  });

  test("reports a null capture time for a row with no timestamp", () => {
    messagesRef.value = [
      makeMessage({ attachments: [makeDisplayAttachment({ id: "att-1" })] }),
    ];

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries[0]!.capturedAt).toBeNull();
  });

  test("hands back the same empty array across renders", () => {
    messagesRef.value = [makeMessage({})];

    const { result, rerender } = renderHook(() =>
      useConversationAttachments(TARGET),
    );
    const first = result.current.entries;
    rerender();

    expect(result.current.entries).toHaveLength(0);
    expect(result.current.entries).toBe(first);
  });

  test("lists the loaded transcript when the target owns the snapshot", () => {
    messagesRef.value = [
      makeMessage({ attachments: [makeDisplayAttachment({ id: "mine" })] }),
    ];

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries.map((entry) => entry.attachment.id)).toEqual([
      "mine",
    ]);
  });

  test("lists nothing when another conversation owns the snapshot", () => {
    seedTranscriptOwner(TARGET.assistantId, "conv-2");
    messagesRef.value = [
      makeMessage({ attachments: [makeDisplayAttachment({ id: "theirs" })] }),
    ];

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries).toHaveLength(0);
    expect(result.current.totalFiles).toBe(0);
  });

  test("lists nothing when another assistant owns the snapshot", () => {
    seedTranscriptOwner("asst-2", TARGET.conversationId);
    messagesRef.value = [
      makeMessage({ attachments: [makeDisplayAttachment({ id: "theirs" })] }),
    ];

    const { result } = renderHook(() => useConversationAttachments(TARGET));

    expect(result.current.entries).toHaveLength(0);
    expect(result.current.totalFiles).toBe(0);
  });

  test("lists nothing when no conversation owns the snapshot", () => {
    clearTranscriptOwner();
    messagesRef.value = [
      makeMessage({ attachments: [makeDisplayAttachment({ id: "draft" })] }),
    ];

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

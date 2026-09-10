/**
 * Tests for `useConversationAttachments` on both of its paths.
 *
 * The transcript rows are seeded into the chat-session store in the shape the
 * store itself holds and the daemon's two lists into the query cache under the
 * keys the hook reads them from, so the hook runs its real subscription and its
 * real queries: what is asserted is the walk over those rows, that a streaming
 * turn does not disturb it, and which path answers for a given assistant
 * version. The gate is opened through the identity store rather than mocked,
 * since a `mock.module` call is process-global.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { makeDisplayAttachment } from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import {
  clearTranscriptMessages,
  clearTranscriptOwner,
  makeAttachmentSummary,
  holdOrgHeaderUnresolved,
  makeChatInfoQueryClient,
  makeTranscriptRow,
  reportAssistantVersion,
  seedAttachmentList,
  seedQueryFailure,
  seedTranscriptMessages,
} from "@/domains/chat/components/chat-info.test-helper";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import {
  conversationAttachmentListArgs,
  useConversationAttachments,
} from "@/domains/chat/hooks/use-conversation-attachments";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { attachmentsGetInfiniteQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { ConversationAttachmentSummary } from "@/types/attachment-types";
import { ApiError } from "@/utils/api-errors";

const TARGET = { assistantId: "asst-1", conversationId: "conv-1" };

/** A version below the gate's floor: the assistant serves no list route. */
const BELOW_GATE_VERSION = "0.11.9";

/** The two list keys the hook reads, files first. */
const LIST_KEYS = (["exclude", "only"] as const).map((sightFrames) =>
  attachmentsGetInfiniteQueryKey(
    conversationAttachmentListArgs(
      TARGET.assistantId,
      TARGET.conversationId,
      sightFrames,
    ),
  ),
);

/** Seeds `messages` as the transcript the target conversation owns. */
function seed(messages: DisplayMessage[]): void {
  seedTranscriptMessages(TARGET.assistantId, TARGET.conversationId, messages);
}

/**
 * The hook under a client of the test's own. Every test renders through this,
 * so the two list queries always have a client, whichever path answers.
 */
function renderAttachments({
  client = makeChatInfoQueryClient(),
  onRender = () => {},
}: { client?: QueryClient; onRender?: () => void } = {}) {
  const view = renderHook(
    () => {
      onRender();
      return useConversationAttachments(TARGET);
    },
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  return { ...view, client };
}

/** Seeds both list reads, so the daemon path has an answer for each. */
function seedLists(
  client: QueryClient,
  {
    files = [],
    frames = [],
    totalFiles,
    totalFrames,
  }: {
    files?: ConversationAttachmentSummary[];
    frames?: ConversationAttachmentSummary[];
    totalFiles?: number;
    totalFrames?: number;
  },
): void {
  seedAttachmentList(client, {
    ...TARGET,
    sightFrames: "exclude",
    attachments: files,
    total: totalFiles,
  });
  seedAttachmentList(client, {
    ...TARGET,
    sightFrames: "only",
    attachments: frames,
    total: totalFrames,
  });
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

let restoreAssistantVersion = () => {};
let releaseOrgHeader = () => {};

beforeEach(() => {
  seed([]);
});

afterEach(() => {
  // Both restores run after the render is torn down, so no query can enable
  // itself on the way out and reach a daemon this suite does not run.
  cleanup();
  clearTranscriptMessages();
  restoreAssistantVersion();
  restoreAssistantVersion = () => {};
  releaseOrgHeader();
  releaseOrgHeader = () => {};
  // The store is a module singleton, so its loading flag goes back to the
  // value a fresh chat session starts on.
  useChatSessionStore.setState({ isLoadingHistory: true });
});

/** Reports a version the gate opens on, restored when the test is over. */
function openGate(version?: string): void {
  restoreAssistantVersion = reportAssistantVersion(version);
}

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

    const { result } = renderAttachments();

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
    expect(result.current.sourceState).toBe("ready");
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

    const { result } = renderAttachments();

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

    const { result } = renderAttachments();

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

    const { result } = renderAttachments();

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

    const { result } = renderAttachments();

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

    const { result } = renderAttachments();

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

    const { result } = renderAttachments();

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

    const { result } = renderAttachments();

    expect(result.current.entries[0]!.capturedAt).toBeNull();
  });

  test("hands back the same empty array across renders", () => {
    seed([makeTranscriptRow({})]);

    const { result, rerender } = renderAttachments();
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
    const { result } = renderAttachments({
      onRender: () => {
        renders += 1;
      },
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
    const { result } = renderAttachments({
      onRender: () => {
        renders += 1;
      },
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

    const { result } = renderAttachments();

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

    const { result } = renderAttachments();

    expect(result.current.entries).toHaveLength(0);
    expect(result.current.totalFiles).toBe(0);
    expect(result.current.sourceState).toBe("unresolved");
  });

  test("lists nothing when another assistant owns the snapshot", () => {
    seedTranscriptMessages("asst-2", TARGET.conversationId, [
      makeTranscriptRow({
        attachments: [makeDisplayAttachment({ id: "theirs" })],
      }),
    ]);

    const { result } = renderAttachments();

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

    const { result } = renderAttachments();

    expect(result.current.entries).toHaveLength(0);
    expect(result.current.totalFiles).toBe(0);
    expect(result.current.sourceState).toBe("unresolved");
  });

  // An owned conversation with no snapshot yet is the first paint of a chat:
  // no files listed, and not yet the same thing as a chat with none.
  test("is unsettled while the history load is in flight", () => {
    ownWithoutSnapshot(true);

    const { result } = renderAttachments();

    expect(result.current.sourceState).toBe("unresolved");
    expect(result.current.entries).toHaveLength(0);
  });

  // A history load that failed sets the flag down and leaves the snapshot
  // null, and no later load is coming: waiting on a snapshot here would keep
  // the caller unsettled for the rest of the session.
  test("settles once a failed history load is over", () => {
    ownWithoutSnapshot(false);

    const { result } = renderAttachments();

    expect(result.current.sourceState).toBe("ready");
    expect(result.current.entries).toHaveLength(0);
  });

  test("keeps the load-more callbacks stable", () => {
    const { result, rerender } = renderAttachments();
    const { loadMoreFiles, loadMoreFrames } = result.current;
    rerender();

    expect(result.current.loadMoreFiles).toBe(loadMoreFiles);
    expect(result.current.loadMoreFrames).toBe(loadMoreFrames);
  });
});

describe("useConversationAttachments on the daemon path", () => {
  const PHOTO = makeAttachmentSummary({
    id: "photo-1",
    filename: "photo-1.png",
    createdAt: 1_000,
  });
  const FRAME = makeAttachmentSummary({
    id: "frame-1",
    filename: "frame-1.jpg",
    mimeType: "image/jpeg",
    createdAt: 4_000,
    sightFrame: true,
    thumbnailData: "dGh1bWI=",
  });

  /** Puts one list into the state the daemon client leaves behind for `status`. */
  function failList(
    client: QueryClient,
    queryKey: readonly unknown[],
    status: number,
  ): void {
    seedQueryFailure(client, queryKey);
    client
      .getQueryCache()
      .find({ queryKey })!
      .setState({ error: new ApiError(status, `HTTP ${status}`) });
  }

  test("lists both of the daemon's lists, files first", () => {
    openGate();
    const client = makeChatInfoQueryClient();
    seedLists(client, { files: [PHOTO], frames: [FRAME] });

    const { result } = renderAttachments({ client });

    expect(result.current.source).toBe("daemon");
    expect(result.current.entries.map((entry) => entry.key)).toEqual([
      "photo-1",
      "frame-1",
    ]);
    expect(result.current.sourceState).toBe("ready");
  });

  test("carries a frame's tag, its capture time, and its thumbnail", () => {
    openGate();
    const client = makeChatInfoQueryClient();
    seedLists(client, { files: [PHOTO], frames: [FRAME] });

    const { result } = renderAttachments({ client });
    const frame = result.current.entries[1]!;

    expect(frame.sightFrame).toBe(true);
    expect(frame.capturedAt).toBe(4_000);
    // The bytes are fetched lazily under the shared attachment-content key, so
    // the listing itself hands the tile a thumbnail and nothing else.
    expect(frame.attachment.previewUrl).toBeNull();
    expect(frame.attachment.thumbnailUrl).toBe(
      "data:image/jpeg;base64,dGh1bWI=",
    );
    expect(result.current.entries[0]!.sightFrame).toBe(false);
  });

  test("reports each category's total and what is left beyond it", () => {
    openGate();
    const client = makeChatInfoQueryClient();
    seedLists(client, {
      files: [PHOTO],
      frames: [FRAME],
      totalFiles: 3,
      totalFrames: 260,
    });

    const { result } = renderAttachments({ client });

    expect(result.current.totalFiles).toBe(3);
    expect(result.current.totalFrames).toBe(260);
    expect(result.current.hasMoreFiles).toBe(true);
    expect(result.current.hasMoreFrames).toBe(true);
  });

  test("asks for nothing more once a list is complete", () => {
    openGate();
    const client = makeChatInfoQueryClient();
    seedLists(client, { files: [PHOTO], frames: [FRAME] });

    const { result } = renderAttachments({ client });

    expect(result.current.hasMoreFiles).toBe(false);
    expect(result.current.hasMoreFrames).toBe(false);
  });

  test("requests the next page of frames from the offset it has loaded", async () => {
    openGate();
    const client = makeChatInfoQueryClient();
    seedLists(client, { files: [PHOTO], frames: [FRAME], totalFrames: 2 });
    const requested: string[] = [];
    const realFetch = globalThis.fetch;
    const stub: typeof fetch = (input) => {
      requested.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            attachments: [makeAttachmentSummary({ id: "frame-2" })],
            total: 2,
            hasMore: false,
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    };
    stub.preconnect = realFetch.preconnect;
    globalThis.fetch = stub;

    try {
      const { result } = renderAttachments({ client });
      act(() => {
        result.current.loadMoreFrames();
      });
      await waitFor(() => {
        expect(result.current.entries).toHaveLength(3);
      });

      expect(requested).toHaveLength(1);
      expect(requested[0]).toContain("sightFrames=only");
      expect(requested[0]).toContain("offset=1");
      expect(result.current.entries.map((entry) => entry.key)).toEqual([
        "photo-1",
        "frame-1",
        "frame-2",
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("re-reads both lists when the transcript's attachments change", () => {
    openGate();
    const client = makeChatInfoQueryClient();
    seedLists(client, { files: [PHOTO], frames: [FRAME] });
    const invalidated: unknown[] = [];
    client.invalidateQueries = (filters) => {
      invalidated.push(filters);
      return Promise.resolve();
    };

    renderAttachments({ client });

    expect(invalidated).toEqual([]);
    // A frame kept while the panel is open reaches the transcript over SSE.
    act(() => {
      useChatSessionStore.getState().patchSnapshotMessages((prev) => [
        ...prev,
        makeTranscriptRow({
          id: "msg-kept",
          timestamp: 5_000,
          attachments: [makeDisplayAttachment({ id: "frame-2" })],
        }),
      ]);
    });

    expect(invalidated).toEqual([
      { queryKey: LIST_KEYS[0] },
      { queryKey: LIST_KEYS[1] },
    ]);
  });

  test("lists the transcript unchanged below the gate", () => {
    openGate(BELOW_GATE_VERSION);
    seed([
      makeTranscriptRow({
        attachments: [makeDisplayAttachment({ id: "from-transcript" })],
      }),
    ]);
    const client = makeChatInfoQueryClient();
    seedLists(client, { files: [PHOTO], frames: [FRAME], totalFrames: 9 });

    const { result } = renderAttachments({ client });

    expect(result.current.source).toBe("transcript");
    expect(result.current.entries.map((entry) => entry.key)).toEqual([
      "from-transcript",
    ]);
    expect(result.current.totalFiles).toBe(1);
    expect(result.current.totalFrames).toBe(0);
    expect(result.current.hasMoreFrames).toBe(false);
    expect(result.current.sourceState).toBe("ready");
  });

  // A build carrying the gated version but cut before the route landed is the
  // gate's blind spot, and it is the old behavior rather than a failure.
  test("falls back to the transcript when the route answers 404", () => {
    openGate();
    seed([
      makeTranscriptRow({
        attachments: [makeDisplayAttachment({ id: "from-transcript" })],
      }),
    ]);
    const client = makeChatInfoQueryClient();
    for (const queryKey of LIST_KEYS) {
      failList(client, queryKey, 404);
    }

    const { result } = renderAttachments({ client });

    expect(result.current.source).toBe("transcript");
    expect(result.current.entries.map((entry) => entry.key)).toEqual([
      "from-transcript",
    ]);
    expect(result.current.sourceState).toBe("ready");
  });

  test("reports a settled list failure as a failed source", () => {
    openGate();
    const client = makeChatInfoQueryClient();
    seedAttachmentList(client, {
      ...TARGET,
      sightFrames: "exclude",
      attachments: [PHOTO],
    });
    failList(client, LIST_KEYS[1]!, 500);

    const { result } = renderAttachments({ client });

    expect(result.current.sourceState).toBe("failed");
  });

  // The panel is never empty on open: the transcript's own files are on screen
  // from the first paint, and the lists replace them once both have answered.
  test("shows the transcript's files while the lists are unresolved", () => {
    openGate();
    // The org header is the gate the list reads wait on, so an unresolved one
    // leaves them unanswered with nothing requested.
    releaseOrgHeader = holdOrgHeaderUnresolved();
    seed([
      makeTranscriptRow({
        attachments: [makeDisplayAttachment({ id: "from-transcript" })],
      }),
    ]);

    const { result } = renderAttachments();

    expect(result.current.entries.map((entry) => entry.key)).toEqual([
      "from-transcript",
    ]);
    expect(result.current.sourceState).toBe("unresolved");
  });
});

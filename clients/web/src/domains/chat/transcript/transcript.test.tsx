/**
 * Smoke tests for the `Transcript` component.
 *
 * The repo doesn't run DOM-based tests (no `@testing-library/react`). We
 * verify behavior via `renderToStaticMarkup` plus `mock.module` shims that
 * replace leaf rendering dependencies with deterministic stubs.
 *
 * The component uses plain `flex-col` to render items: history items
 * appear first in DOM order (visual top, oldest first) and the
 * LatestTurnRow follows at the end of the DOM (visual bottom).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, useEffect } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";

// `ChatMarkdownMessage` pulls in `react-markdown` + `remark-gfm`. They render
// fine under `renderToStaticMarkup`, but to keep these tests hermetic we
// replace it with a plain passthrough.
mock.module("@/domains/chat/components/chat-markdown-message", () => ({
  ChatMarkdownMessage: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

// `SurfaceRouter` fans out to many per-surface renderers; stub with a
// sentinel.
mock.module("@/components/assistant/surfaces", () => ({
  SurfaceRouter: ({ surface }: { surface: { surfaceId: string } }) => (
    <div data-testid="surface" data-surface-id={surface.surfaceId} />
  ),
}));

// `MessageHoverActions` uses `navigator.clipboard` in a handler; replace
// with a minimal stub so the server render is deterministic.
mock.module(
  "@/domains/chat/components/message-hover-actions/message-hover-actions",
  () => ({
    MessageHoverActions: () => <div data-testid="hover-actions" />,
  }),
);

mock.module("@/domains/chat/components/tool-call-chip/tool-call-chip", () => ({
  ToolCallChip: () => <div data-testid="tool-call" />,
}));

mock.module(
  "@/domains/chat/components/chat-attachments/message-attachments",
  () => ({
    MessageAttachments: () => <div data-testid="attachments" />,
  }),
);

// The reopen link names its own document from the documents query; that is
// covered by `document-reopen-link.test`. Stub it to a bare marker so these
// tests assert what the transcript owns: how many links a response ends with
// and which message carries them.
mock.module("@/domains/chat/transcript/document-reopen-link", () => ({
  DocumentReopenLink: ({ surfaceId }: { surfaceId: string }) => (
    <span data-testid="document-reopen-link" data-surface-id={surfaceId} />
  ),
}));

// ---------------------------------------------------------------------------
// Subjects under test — imported AFTER mocks are registered.
// ---------------------------------------------------------------------------

import { renderToStaticMarkup } from "react-dom/server";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { TranscriptItem } from "@/domains/chat/transcript/types";

import { Transcript } from "@/domains/chat/transcript/transcript";
import { resetResponseArtifactAwards } from "@/domains/chat/transcript/resolve-response-artifacts";
import { INITIAL_TURN_STATE, useTurnStore } from "@/domains/chat/turn-store";
import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";

import { textBody } from "@/domains/chat/utils/message-test-helpers";
function userMessage(id: string, content: string): TranscriptItem {
  const msg: DisplayMessage = {
    id,
    role: "user",
    ...textBody(content),
  };
  return { kind: "message", key: id, message: msg };
}

function assistantMessage(id: string, content: string): TranscriptItem {
  const msg: DisplayMessage = {
    id,
    role: "assistant",
    ...textBody(content),
  };
  return { kind: "message", key: id, message: msg };
}

const noop = () => {};

describe("Transcript", () => {
  test("with empty items, renders zero rows", () => {
    const html = renderToStaticMarkup(
      <Transcript items={[]} conversationId={null} onSurfaceAction={noop} />,
    );
    // No message content → no rendered rows.
    expect(html).not.toContain('data-latest-turn="true"');
    expect(html).not.toContain('data-testid="markdown"');
  });

  test("scroll container has flex-col class (chronological order)", () => {
    const html = renderToStaticMarkup(
      <Transcript items={[]} conversationId={null} onSurfaceAction={noop} />,
    );
    expect(html).toContain("flex-col");
    expect(html).not.toContain("flex-col-reverse");
  });

  test("with trailing user message, renders history rows and a latest-turn row", () => {
    const items: TranscriptItem[] = [
      assistantMessage("a1", "hello"),
      userMessage("u1", "first question"),
      assistantMessage("a2", "some reply"),
      userMessage("u2", "latest question"),
      assistantMessage("a3", "streaming reply"),
    ];
    // partitionLatestTurn -> historyItems: [a1, u1, a2] (3), anchor: u2,
    //                       responseItems: [a3].
    const html = renderToStaticMarkup(
      <Transcript items={items} conversationId={null} onSurfaceAction={noop} />,
    );

    // All history message content appears in the rendered output.
    expect(html).toContain("hello");
    expect(html).toContain("first question");
    expect(html).toContain("some reply");

    // LatestTurnRow renders the anchor message + response items inline.
    expect(html).toContain("latest question");
    expect(html).toContain("streaming reply");

    // Marker attributes emitted by LatestTurnRow.
    expect(html).toContain('data-latest-turn="true"');
    expect(html).toContain('data-latest-edge="true"');
  });

  test("with no user messages at all, no latest-turn row is rendered", () => {
    const items: TranscriptItem[] = [
      assistantMessage("a1", "only assistant"),
      assistantMessage("a2", "also assistant"),
    ];
    const html = renderToStaticMarkup(
      <Transcript items={items} conversationId={null} onSurfaceAction={noop} />,
    );

    expect(html).not.toContain('data-latest-turn="true"');
    // History items still render.
    expect(html).toContain("only assistant");
    expect(html).toContain("also assistant");
  });

  test("items render in correct visual order (flex-col: history first in DOM, latest-turn last)", () => {
    const items: TranscriptItem[] = [
      assistantMessage("a1", "FIRST_MSG"),
      userMessage("u1", "SECOND_MSG"),
      assistantMessage("a2", "THIRD_MSG"),
    ];
    // partition: history=[a1], anchor=u1, response=[a2]
    const html = renderToStaticMarkup(
      <Transcript items={items} conversationId={null} onSurfaceAction={noop} />,
    );

    // In flex-col DOM order: history items come first (visual top),
    // LatestTurnRow (u1 + a2) is rendered last (visual bottom).
    const latestTurnIdx = html.indexOf('data-latest-turn="true"');
    const firstMsgIdx = html.indexOf("FIRST_MSG");
    expect(latestTurnIdx).toBeGreaterThanOrEqual(0);
    expect(firstMsgIdx).toBeGreaterThanOrEqual(0);
    // History appears first in DOM (before LatestTurnRow).
    expect(firstMsgIdx).toBeLessThan(latestTurnIdx);
  });
});

describe("Transcript avatar slot", () => {
  test("renderAvatar with no anchor (assistant-only history) still mounts the avatar at the bottom", () => {
    // No user message → no anchor. Avatar must still appear so the
    // bottom-of-conversation slot is conversation-agnostic.
    const items: TranscriptItem[] = [assistantMessage("a1", "only assistant")];
    const html = renderToStaticMarkup(
      <Transcript
        items={items}
        conversationId={null}
        onSurfaceAction={noop}

        renderAvatar={() => <span>AVATAR_SLOT_MARKER</span>}
      />,
    );

    expect(html).not.toContain('data-latest-turn="true"');
    expect(html).toContain('data-latest-assistant-avatar="true"');
    expect(html).toContain("AVATAR_SLOT_MARKER");
    expect(html).toContain('data-latest-edge="true"');
  });

  test("renderAvatar with anchor: avatar appears AFTER the latest-turn cluster but BEFORE the latest-edge sentinel", () => {
    const items: TranscriptItem[] = [
      assistantMessage("a1", "history"),
      userMessage("u1", "ANCHOR_MARKER"),
      assistantMessage("a2", "RESPONSE_MARKER"),
    ];
    const html = renderToStaticMarkup(
      <Transcript
        items={items}
        conversationId={null}
        onSurfaceAction={noop}

        renderAvatar={() => <span>AVATAR_SLOT_MARKER</span>}
      />,
    );

    const anchorIdx = html.indexOf("ANCHOR_MARKER");
    const responseIdx = html.indexOf("RESPONSE_MARKER");
    const avatarIdx = html.indexOf('data-latest-assistant-avatar="true"');
    const edgeIdx = html.indexOf('data-latest-edge="true"');

    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    expect(responseIdx).toBeGreaterThanOrEqual(0);
    expect(avatarIdx).toBeGreaterThanOrEqual(0);
    expect(edgeIdx).toBeGreaterThanOrEqual(0);

    // anchor → response → avatar → edge sentinel
    expect(anchorIdx).toBeLessThan(responseIdx);
    expect(responseIdx).toBeLessThan(avatarIdx);
    expect(avatarIdx).toBeLessThan(edgeIdx);
  });

  test("renderAvatar omitted → no avatar slot rendered", () => {
    const items: TranscriptItem[] = [
      userMessage("u1", "question"),
      assistantMessage("a1", "reply"),
    ];
    const html = renderToStaticMarkup(
      <Transcript items={items} conversationId={null} onSurfaceAction={noop} />,
    );

    expect(html).not.toContain('data-latest-assistant-avatar="true"');
    // Latest-edge sentinel still renders because the anchor exists.
    expect(html).toContain('data-latest-edge="true"');
  });

  test("renderAvatar with neither anchor nor history → avatar still renders (empty conversation w/ avatar)", () => {
    const html = renderToStaticMarkup(
      <Transcript
        items={[]}
        conversationId={null}
        onSurfaceAction={noop}

        renderAvatar={() => <span>AVATAR_SLOT_MARKER</span>}
      />,
    );
    expect(html).toContain('data-latest-assistant-avatar="true"');
    expect(html).toContain("AVATAR_SLOT_MARKER");
  });

  // Codex P2 #1 regression. When `renderAvatar` is provided but there is
  // NO anchor message (assistant-only history — e.g. a recovered conversation
  // whose user message was lost, or the onboarding-only state), the latest-
  // edge wrapper must not apply `minHeight: viewportMinHeight`. If it did,
  // the wrapper would occupy a full viewport-height region after the last
  // history item, and the bottom-pin scroll on conversation switch (see
  // `595071cbb1 — scroll to bottom on transcript container DOM attach`)
  // would land on blank space + the avatar instead of on the actual latest
  // assistant message.
  test("renderAvatar with no anchor: latest-edge wrapper does NOT apply viewport-height min-height", () => {
    const items: TranscriptItem[] = [
      assistantMessage("a1", "LATEST_ASSISTANT_MSG"),
    ];
    const html = renderToStaticMarkup(
      <Transcript
        items={items}
        conversationId="conv-1"
        onSurfaceAction={noop}

        renderAvatar={() => <span>AVATAR_SLOT_MARKER</span>}
      />,
    );

    // Sanity: avatar + edge sentinel both render.
    expect(html).toContain('data-latest-assistant-avatar="true"');
    expect(html).toContain('data-latest-edge="true"');
    // The only place the component sets `min-height` is the latest-edge
    // wrapper. With no anchor, that style must be omitted entirely.
    expect(html).not.toContain("min-height");
  });

  test("renderAvatar with anchor: latest-edge wrapper applies min-height (viewport pinning preserved)", () => {
    const items: TranscriptItem[] = [userMessage("u1", "ANCHOR_MARKER")];
    const html = renderToStaticMarkup(
      <Transcript
        items={items}
        conversationId="conv-1"
        onSurfaceAction={noop}

        renderAvatar={() => <span>AVATAR_SLOT_MARKER</span>}
      />,
    );

    // Min-height attribute must be present so the anchor pins to the top
    // and the flex-1 spacer pushes the avatar to the bottom.
    expect(html).toContain("min-height");
  });

  // Layout invariant: the avatar must sit directly below the response
  // items, NOT below the `flex-1` spacer. With anchor + avatar, the spacer
  // pushes the latest-edge sentinel to the bottom of the viewport — but
  // the avatar must stay attached to the assistant's content, not get
  // pushed away with the sentinel.
  test("renderAvatar with anchor: avatar appears BEFORE the flex-1 spacer", () => {
    const items: TranscriptItem[] = [
      userMessage("u1", "ANCHOR_MARKER"),
      assistantMessage("a1", "RESPONSE_MARKER"),
    ];
    const html = renderToStaticMarkup(
      <Transcript
        items={items}
        conversationId="conv-1"
        onSurfaceAction={noop}

        renderAvatar={() => <span>AVATAR_SLOT_MARKER</span>}
      />,
    );

    const responseIdx = html.indexOf("RESPONSE_MARKER");
    const avatarIdx = html.indexOf('data-latest-assistant-avatar="true"');
    const spacerIdx = html.indexOf('data-latest-edge-spacer="true"');
    const edgeIdx = html.indexOf('data-latest-edge="true"');

    expect(responseIdx).toBeGreaterThanOrEqual(0);
    expect(avatarIdx).toBeGreaterThanOrEqual(0);
    expect(spacerIdx).toBeGreaterThanOrEqual(0);
    expect(edgeIdx).toBeGreaterThanOrEqual(0);

    // response → avatar → spacer → edge sentinel
    expect(responseIdx).toBeLessThan(avatarIdx);
    expect(avatarIdx).toBeLessThan(spacerIdx);
    expect(spacerIdx).toBeLessThan(edgeIdx);
  });

  test("no anchor: no flex-1 spacer rendered (avatar sits inline under history)", () => {
    const items: TranscriptItem[] = [assistantMessage("a1", "history one")];
    const html = renderToStaticMarkup(
      <Transcript
        items={items}
        conversationId="conv-1"
        onSurfaceAction={noop}

        renderAvatar={() => <span>AVATAR_SLOT_MARKER</span>}
      />,
    );

    expect(html).toContain('data-latest-assistant-avatar="true"');
    // No spacer in the no-anchor case — avatar sits inline.
    expect(html).not.toContain('data-latest-edge-spacer="true"');
  });

  test("anchor without renderAvatar: still applies min-height (viewport pinning is for the anchor, not the avatar)", () => {
    const items: TranscriptItem[] = [
      userMessage("u1", "ANCHOR_MARKER"),
      assistantMessage("a1", "RESPONSE_MARKER"),
    ];
    const html = renderToStaticMarkup(
      <Transcript
        items={items}
        conversationId="conv-1"
        onSurfaceAction={noop}
      />,
    );

    expect(html).not.toContain('data-latest-assistant-avatar="true"');
    expect(html).toContain("min-height");
  });
});

// ---------------------------------------------------------------------------
// Codex P2 #2 regression — DOM identity across no-anchor → anchor transition.
//
// The latest-edge wrapper has unkeyed conditional children. Codex's review
// claimed that inserting `<LatestTurnRow>` at slot 0 (was `false`) would
// cause React to "reconcile the following <div>s by index", reusing the
// current avatar wrapper as the spacer and remounting `ChatAvatar`, replaying
// the entrance-spring animation. Empirically that does NOT happen — React's
// reconciler tracks `fiber.index` (the OLD render's position), so the
// existing avatar fiber at fiber.index=2 still matches newIdx=2 even after
// the conditional slot 0 lights up. This test locks in the correct behavior
// so a future refactor (e.g. reordering siblings, changing the conditional
// shape) doesn't silently regress.
// ---------------------------------------------------------------------------
describe("Transcript no-anchor → anchor transition preserves avatar DOM identity", () => {
  afterEach(() => {
    cleanup();
  });

  test("ChatAvatar instance is NOT remounted when first user anchor appears", async () => {
    let avatarMountCount = 0;
    let avatarUnmountCount = 0;
    function MountTracker() {
      useEffect(() => {
        avatarMountCount++;
        return () => {
          avatarUnmountCount++;
        };
      }, []);
      return <span data-testid="mount-tracker">avatar</span>;
    }

    // Start with assistant-only history + renderAvatar. No anchor.
    const historyOnly: TranscriptItem[] = [
      assistantMessage("a1", "history one"),
    ];

    const renderAvatar = () => <MountTracker />;

    const { rerender } = render(
      <Transcript
        items={historyOnly}
        conversationId="conv-1"
        onSurfaceAction={noop}

        renderAvatar={renderAvatar}
      />,
    );
    expect(avatarMountCount).toBe(1);
    expect(avatarUnmountCount).toBe(0);

    // Now insert the first user message → anchor lights up. This is the
    // exact transition Codex flagged.
    const withAnchor: TranscriptItem[] = [
      assistantMessage("a1", "history one"),
      userMessage("u1", "first user message"),
    ];
    await act(async () => {
      rerender(
        <Transcript
          items={withAnchor}
          conversationId="conv-1"
          onSurfaceAction={noop}

          renderAvatar={renderAvatar}
        />,
      );
    });

    // CRITICAL: ChatAvatar must NOT have been unmounted + remounted.
    // If it had, entrance-spring state would replay on every first-turn
    // landing — exactly the flicker this PR is preventing.
    expect(avatarMountCount).toBe(1);
    expect(avatarUnmountCount).toBe(0);

    // Reverse direction: drop the anchor (e.g. message deletion or
    // conversation restore). Avatar identity must still be preserved.
    await act(async () => {
      rerender(
        <Transcript
          items={historyOnly}
          conversationId="conv-1"
          onSurfaceAction={noop}

          renderAvatar={renderAvatar}
        />,
      );
    });
    expect(avatarMountCount).toBe(1);
    expect(avatarUnmountCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A response is many messages (thinking, tool runs, document edits, more
// text), and several of them commonly write the same document. The reopen link
// belongs to the response, not to each message that wrote: one link per
// document, on the message that ends the response, once the turn has settled.
// ---------------------------------------------------------------------------
describe("Transcript changed-document reopen links", () => {
  afterEach(() => {
    cleanup();
    useTurnStore.setState(INITIAL_TURN_STATE);
    // These cases share one conversation id and reuse message ids across
    // cases, which the awards would otherwise carry from one to the next.
    resetResponseArtifactAwards();
  });

  /** A settled `document_update` whose result carries the surface it wrote. */
  function updateCall(id: string, surfaceId: string): ChatMessageToolCall {
    return {
      id,
      name: "document_update",
      input: { surface_id: surfaceId, content: "notes" },
      result: JSON.stringify({ success: true, surface_id: surfaceId }),
      completedAt: 1,
    };
  }

  function editingMessage(
    id: string,
    toolCalls: ChatMessageToolCall[],
  ): TranscriptItem {
    const msg: DisplayMessage = {
      id,
      role: "assistant",
      toolCalls,
      contentBlocks: toolCalls.map((toolCall) => ({
        type: "tool_use",
        toolCall,
      })),
    };
    return { kind: "message", key: id, message: msg };
  }

  function renderTranscript(items: TranscriptItem[]) {
    return render(
      <Transcript
        items={items}
        conversationId="conv-doc"
        assistantId="asst-doc"
        onSurfaceAction={noop}
        onOpenDocument={noop}
      />,
    );
  }

  function reopenSurfaceIds(container: HTMLElement): (string | null)[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        "[data-testid='document-reopen-link']",
      ),
    ).map((link) => link.getAttribute("data-surface-id"));
  }

  /** The response's three messages, all writing the same document. */
  const threeEditsOfOneDocument: TranscriptItem[] = [
    userMessage("u1", "update my notes"),
    editingMessage("a1", [updateCall("tc-1", "surf-notes")]),
    editingMessage("a2", [updateCall("tc-2", "surf-notes")]),
    editingMessage("a3", [updateCall("tc-3", "surf-notes")]),
  ];

  test("renders exactly one link for a document three messages of the response changed", () => {
    const { container } = renderTranscript(threeEditsOfOneDocument);

    expect(reopenSurfaceIds(container)).toEqual(["surf-notes"]);
  });

  test("renders one link per distinct document the response changed", () => {
    const { container } = renderTranscript([
      userMessage("u1", "update both"),
      editingMessage("a1", [updateCall("tc-1", "surf-notes")]),
      editingMessage("a2", [updateCall("tc-2", "surf-plan")]),
    ]);

    expect(reopenSurfaceIds(container)).toEqual(["surf-notes", "surf-plan"]);
  });

  test("puts the link on the final message of the response, not the earlier ones", () => {
    const { container } = renderTranscript(threeEditsOfOneDocument);

    const link = container.querySelector<HTMLElement>(
      "[data-testid='document-reopen-link']",
    )!;
    expect(
      link.closest("[data-message-id]")!.getAttribute("data-message-id"),
    ).toBe("a3");
  });

  test("renders no link while the response is still streaming", () => {
    useTurnStore.setState({ phase: "streaming" });

    const { container } = renderTranscript(threeEditsOfOneDocument);

    expect(reopenSurfaceIds(container)).toEqual([]);
  });

  test("renders no link while the response waits on the user", () => {
    useTurnStore.setState({ phase: "awaiting_user_input" });

    const { container } = renderTranscript(threeEditsOfOneDocument);

    expect(reopenSurfaceIds(container)).toEqual([]);
  });

  test("renders the link once the streaming response settles", async () => {
    useTurnStore.setState({ phase: "streaming" });
    const { container } = renderTranscript(threeEditsOfOneDocument);
    expect(reopenSurfaceIds(container)).toEqual([]);

    await act(async () => {
      useTurnStore.setState({ phase: "idle" });
    });

    expect(reopenSurfaceIds(container)).toEqual(["surf-notes"]);
  });

  test("keeps the link on a completed response reseeded from history", () => {
    const { container, rerender } = renderTranscript(threeEditsOfOneDocument);
    expect(reopenSurfaceIds(container)).toEqual(["surf-notes"]);

    // A reseed from `/messages` rebuilds every row out of the persisted wire
    // payload: fresh object identities, none of the live stream state.
    const reseeded = JSON.parse(
      JSON.stringify(threeEditsOfOneDocument),
    ) as TranscriptItem[];
    rerender(
      <Transcript
        items={reseeded}
        conversationId="conv-doc"
        assistantId="asst-doc"
        onSurfaceAction={noop}
        onOpenDocument={noop}
      />,
    );

    expect(reopenSurfaceIds(container)).toEqual(["surf-notes"]);
  });

  test("ends each earlier response with its own link", () => {
    const { container } = renderTranscript([
      userMessage("u1", "update my notes"),
      editingMessage("a1", [updateCall("tc-1", "surf-notes")]),
      editingMessage("a2", [updateCall("tc-2", "surf-notes")]),
      userMessage("u2", "now the plan"),
      editingMessage("a3", [updateCall("tc-3", "surf-plan")]),
    ]);

    expect(reopenSurfaceIds(container)).toEqual(["surf-notes", "surf-plan"]);
  });

  test("renders no second link when a later response edits the same document", () => {
    // The document is in the conversation's assets from the first response
    // onwards, and the assets pill is where it stays reachable.
    const { container } = renderTranscript([
      userMessage("u1", "update my notes"),
      editingMessage("a1", [updateCall("tc-1", "surf-notes")]),
      userMessage("u2", "one more edit"),
      editingMessage("a2", [updateCall("tc-2", "surf-notes")]),
    ]);

    const links = container.querySelectorAll(
      "[data-testid='document-reopen-link']",
    );
    expect(links.length).toBe(1);
    expect(
      links[0]!.closest("[data-message-id]")!.getAttribute("data-message-id"),
    ).toBe("a1");
  });

  test("keeps the link where it is when an older page arrives above it", () => {
    // The transcript prepends older pages, so the earliest response to touch a
    // document can appear after its card is drawn. Moving the card then would
    // change the height below the viewport, which the prepend's scroll
    // correction reads as prepended content.
    const conversationId = "conv-doc-paged";
    const newestPage = [
      userMessage("u2", "one more edit"),
      editingMessage("a2", [updateCall("tc-2", "surf-notes")]),
    ];
    const render1 = render(
      <Transcript
        items={newestPage}
        conversationId={conversationId}
        assistantId="asst-doc"
        onSurfaceAction={noop}
        onOpenDocument={noop}
      />,
    );
    expect(reopenSurfaceIds(render1.container)).toEqual(["surf-notes"]);

    render1.rerender(
      <Transcript
        items={[
          userMessage("u1", "start my notes"),
          editingMessage("a1", [updateCall("tc-1", "surf-notes")]),
          ...newestPage,
        ]}
        conversationId={conversationId}
        assistantId="asst-doc"
        onSurfaceAction={noop}
        onOpenDocument={noop}
      />,
    );

    const links = render1.container.querySelectorAll(
      "[data-testid='document-reopen-link']",
    );
    expect(links.length).toBe(1);
    expect(
      links[0]!.closest("[data-message-id]")!.getAttribute("data-message-id"),
    ).toBe("a2");
  });
});

// ---------------------------------------------------------------------------
// A phone gives the transcript the whole screen, its header sitting directly on
// the viewport's top edge. Everything the keyboard and the composer push past
// that edge is cut mid line, so the edge fades on mobile while there is
// anything behind it to fade.
// ---------------------------------------------------------------------------
describe("Transcript top fade", () => {
  const viewport = viewportAxesStub();

  afterEach(() => {
    cleanup();
    viewport.restore();
  });

  const items: TranscriptItem[] = [
    assistantMessage("a1", "an older reply"),
    userMessage("u1", "the latest question"),
  ];

  function renderTranscript() {
    return render(
      <Transcript
        items={items}
        conversationId="conv-fade"
        onSurfaceAction={noop}
      />,
    );
  }

  function fadeOf(container: HTMLElement): Element | null {
    return container.querySelector('[data-slot="transcript-top-fade"]');
  }

  /** Scroll the transcript down, as a finger or the keyboard opening does. */
  function scrollTranscriptTo(container: HTMLElement, scrollTopPx: number) {
    const viewportEl = container.querySelector(
      '[data-testid="transcript-scroll-container"]',
    );
    if (!viewportEl) {
      throw new Error("transcript rendered without its scroll container");
    }
    Object.defineProperty(viewportEl, "scrollTop", {
      configurable: true,
      value: scrollTopPx,
    });
    fireEvent.scroll(viewportEl);
  }

  test("a transcript sitting at its top has nothing to fade", () => {
    // GIVEN a phone transcript with its first line whole on screen
    viewport.set({ narrow: true, coarsePointer: true });

    // WHEN it is rendered
    const { container } = renderTranscript();

    // THEN no fade stands over an edge that hides nothing
    expect(fadeOf(container)).toBeNull();
  });

  test("content pushed above the top edge gets a fade over it", () => {
    // GIVEN a phone transcript
    viewport.set({ narrow: true, coarsePointer: true });
    const { container } = renderTranscript();

    // WHEN the composer or the keyboard pushes its earlier lines past the top
    scrollTranscriptTo(container, 240);

    // THEN a fade stands over the edge they leave through, painted from the
    // canvas the transcript sits on
    const fade = fadeOf(container);
    expect(fade).not.toBeNull();
    expect(fade?.className).toContain("from-[var(--surface-base)]");
    expect(fade?.className).toContain("to-transparent");
  });

  test("the fade takes neither taps nor a place in the accessibility tree", () => {
    // GIVEN a phone transcript scrolled off its first line
    viewport.set({ narrow: true, coarsePointer: true });
    const { container } = renderTranscript();
    scrollTranscriptTo(container, 240);

    // THEN the message underneath it stays reachable, and nothing is announced
    const fade = fadeOf(container);
    expect(fade?.className).toContain("pointer-events-none");
    expect(fade?.getAttribute("aria-hidden")).toBe("true");
  });

  test("scrolling back to the top takes the fade away again", () => {
    // GIVEN a phone transcript whose top edge is already faded
    viewport.set({ narrow: true, coarsePointer: true });
    const { container } = renderTranscript();
    scrollTranscriptTo(container, 240);
    expect(fadeOf(container)).not.toBeNull();

    // WHEN the user scrolls back up to the first line
    scrollTranscriptTo(container, 0);

    // THEN the fade goes with the lines it stood over
    expect(fadeOf(container)).toBeNull();
  });

  test("a sub-pixel scroll offset hides no line worth fading", () => {
    // GIVEN a phone transcript parked at the top of a zoomed viewport, where
    // the offset lands just off zero
    viewport.set({ narrow: true, coarsePointer: true });
    const { container } = renderTranscript();

    // WHEN it settles there
    scrollTranscriptTo(container, 0.5);

    // THEN the edge is left alone
    expect(fadeOf(container)).toBeNull();
  });

  test("desktop frames the panel in its own padding and gets no fade", () => {
    // GIVEN a desktop transcript, scrolled well off its first message
    viewport.set({ narrow: false, coarsePointer: false });
    const { container } = renderTranscript();

    // WHEN it is scrolled down
    scrollTranscriptTo(container, 240);

    // THEN the edge is left alone: the panel's own gutter already ends it
    expect(fadeOf(container)).toBeNull();
  });
});

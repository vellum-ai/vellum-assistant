/**
 * Tests for the `Transcript` component.
 *
 * Since LUM-2605 the transcript renders through the `VirtualList`
 * (`react-virtuoso`) primitive, which paints nothing under
 * `renderToStaticMarkup` (its item rendering is driven by layout effects).
 * So the suite is split:
 *
 *  - The composite trailing row's layout invariants (markers, min-height,
 *    child ordering, avatar DOM identity) are unit-tested against the
 *    extracted {@link LatestEdgeRow} via `renderToStaticMarkup` / jsdom —
 *    those assertions don't need virtuoso at all.
 *  - The wiring Transcript owns — that it mounts the list scroller and that
 *    its row-index map resolves message ids (`scrollToMessage`) — is checked
 *    with a jsdom render. NOTE: `react-virtuoso` only paints items when the
 *    test's `VirtuosoMockContext` is the SAME module instance the list renders
 *    with; in this workspace the design-library bundles its own react-virtuoso
 *    copy (distinct from clients/web's), so items don't paint under jsdom
 *    here. The "items flow through virtuoso" path is covered by the
 *    design-library's own VirtualList tests.
 *
 * The transcript uses plain `flex-col`: history items appear first in DOM
 * order (visual top, oldest first) and the latest-edge composite follows
 * at the end (visual bottom).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, createRef, useEffect } from "react";
import { cleanup, render } from "@testing-library/react";

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
mock.module("@/domains/chat/components/message-hover-actions/message-hover-actions", () => ({
  MessageHoverActions: () => <div data-testid="hover-actions" />,
}));

mock.module("@/domains/chat/components/tool-call-chip/tool-call-chip", () => ({
  ToolCallChip: () => <div data-testid="tool-call" />,
}));

mock.module("@/domains/chat/components/chat-attachments/message-attachments", () => ({
  MessageAttachments: () => <div data-testid="attachments" />,
}));

// ---------------------------------------------------------------------------
// Subjects under test — imported AFTER mocks are registered.
// ---------------------------------------------------------------------------

import { renderToStaticMarkup } from "react-dom/server";

import type { DisplayMessage } from "@/domains/chat/types/types";
import type { MessageItem } from "@/domains/chat/transcript/types";

import {
  LatestEdgeRow,
  Transcript,
  type TranscriptHandle,
} from "@/domains/chat/transcript/transcript";

import { textBody } from "@/domains/chat/utils/message-test-helpers";

function userMessage(id: string, content: string): MessageItem {
  const msg: DisplayMessage = {
    id,
    role: "user",
    ...textBody(content),
  };
  return { kind: "message", key: id, message: msg };
}

function assistantMessage(id: string, content: string): MessageItem {
  const msg: DisplayMessage = {
    id,
    role: "assistant",
    ...textBody(content),
  };
  return { kind: "message", key: id, message: msg };
}

const noop = () => {};

/** Minimal shared row props for `LatestEdgeRow` — only `onSurfaceAction` is
 *  required; the rest are optional callbacks the row renderers tolerate. */
const rowProps = { onSurfaceAction: noop };

// ---------------------------------------------------------------------------
// LatestEdgeRow — composite trailing row layout invariants (static markup).
// ---------------------------------------------------------------------------

describe("LatestEdgeRow", () => {
  test("with an anchor, renders the latest-turn cluster and the edge sentinel", () => {
    const html = renderToStaticMarkup(
      <LatestEdgeRow
        anchorMessage={userMessage("u1", "latest question")}
        responseItems={[assistantMessage("a1", "streaming reply")]}
        hasAvatar={false}
        viewportMinHeight={undefined}
        rowProps={rowProps}
      />,
    );

    expect(html).toContain("latest question");
    expect(html).toContain("streaming reply");
    expect(html).toContain('data-latest-turn="true"');
    expect(html).toContain('data-latest-edge="true"');
  });

  test("with no anchor, renders no latest-turn cluster but still the edge sentinel", () => {
    const html = renderToStaticMarkup(
      <LatestEdgeRow
        anchorMessage={null}
        responseItems={[]}
        hasAvatar={false}
        viewportMinHeight={undefined}
        rowProps={rowProps}
      />,
    );

    expect(html).not.toContain('data-latest-turn="true"');
    expect(html).toContain('data-latest-edge="true"');
  });

  test("with an anchor, applies the viewport min-height (anchor pins to top)", () => {
    const html = renderToStaticMarkup(
      <LatestEdgeRow
        anchorMessage={userMessage("u1", "ANCHOR_MARKER")}
        responseItems={[]}
        hasAvatar={false}
        viewportMinHeight={640}
        rowProps={rowProps}
      />,
    );
    expect(html).toContain("min-height");
  });

  test("with no anchor, omits the min-height entirely", () => {
    // Codex P2 #1 regression. With assistant-only history the wrapper must
    // not occupy a full viewport-height region after the last history item,
    // or the bottom-pin would land on blank space instead of the latest
    // assistant message.
    const html = renderToStaticMarkup(
      <LatestEdgeRow
        anchorMessage={null}
        responseItems={[]}
        hasAvatar
        renderAvatar={() => <span>AVATAR_SLOT_MARKER</span>}
        viewportMinHeight={640}
        rowProps={rowProps}
      />,
    );
    expect(html).toContain('data-latest-assistant-avatar="true"');
    expect(html).not.toContain("min-height");
  });
});

describe("LatestEdgeRow avatar slot", () => {
  test("no anchor (assistant-only history) still mounts the avatar", () => {
    const html = renderToStaticMarkup(
      <LatestEdgeRow
        anchorMessage={null}
        responseItems={[]}
        hasAvatar
        renderAvatar={() => <span>AVATAR_SLOT_MARKER</span>}
        viewportMinHeight={undefined}
        rowProps={rowProps}
      />,
    );

    expect(html).not.toContain('data-latest-turn="true"');
    expect(html).toContain('data-latest-assistant-avatar="true"');
    expect(html).toContain("AVATAR_SLOT_MARKER");
    expect(html).toContain('data-latest-edge="true"');
  });

  test("with anchor: avatar appears AFTER the cluster but BEFORE the edge sentinel", () => {
    const html = renderToStaticMarkup(
      <LatestEdgeRow
        anchorMessage={userMessage("u1", "ANCHOR_MARKER")}
        responseItems={[assistantMessage("a1", "RESPONSE_MARKER")]}
        hasAvatar
        renderAvatar={() => <span>AVATAR_SLOT_MARKER</span>}
        viewportMinHeight={640}
        rowProps={rowProps}
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

  test("with anchor: avatar appears BEFORE the flex-1 spacer (stays attached to content)", () => {
    // The spacer pushes the latest-edge sentinel to the viewport bottom — but
    // the avatar must stay attached to the assistant's content, not get
    // pushed away with the sentinel.
    const html = renderToStaticMarkup(
      <LatestEdgeRow
        anchorMessage={userMessage("u1", "ANCHOR_MARKER")}
        responseItems={[assistantMessage("a1", "RESPONSE_MARKER")]}
        hasAvatar
        renderAvatar={() => <span>AVATAR_SLOT_MARKER</span>}
        viewportMinHeight={640}
        rowProps={rowProps}
      />,
    );

    const responseIdx = html.indexOf("RESPONSE_MARKER");
    const avatarIdx = html.indexOf('data-latest-assistant-avatar="true"');
    const spacerIdx = html.indexOf('data-latest-edge-spacer="true"');
    const edgeIdx = html.indexOf('data-latest-edge="true"');

    // response → avatar → spacer → edge sentinel
    expect(responseIdx).toBeLessThan(avatarIdx);
    expect(avatarIdx).toBeLessThan(spacerIdx);
    expect(spacerIdx).toBeLessThan(edgeIdx);
  });

  test("no anchor: no flex-1 spacer rendered (avatar sits inline under history)", () => {
    const html = renderToStaticMarkup(
      <LatestEdgeRow
        anchorMessage={null}
        responseItems={[]}
        hasAvatar
        renderAvatar={() => <span>AVATAR_SLOT_MARKER</span>}
        viewportMinHeight={undefined}
        rowProps={rowProps}
      />,
    );

    expect(html).toContain('data-latest-assistant-avatar="true"');
    expect(html).not.toContain('data-latest-edge-spacer="true"');
  });

  test("anchor without avatar: still applies min-height (pinning is for the anchor)", () => {
    const html = renderToStaticMarkup(
      <LatestEdgeRow
        anchorMessage={userMessage("u1", "ANCHOR_MARKER")}
        responseItems={[assistantMessage("a1", "RESPONSE_MARKER")]}
        hasAvatar={false}
        viewportMinHeight={640}
        rowProps={rowProps}
      />,
    );

    expect(html).not.toContain('data-latest-assistant-avatar="true"');
    expect(html).toContain("min-height");
  });
});

// ---------------------------------------------------------------------------
// Codex P2 #2 regression — DOM identity across no-anchor → anchor transition.
//
// When the anchor lights up, `<LatestTurnRow>` is inserted at slot 0 (was
// `false`). React's reconciler tracks `fiber.index` (the OLD render's
// position), so the existing avatar fiber still matches its new position and
// `ChatAvatar` is NOT remounted — its entrance-spring state is preserved.
// Re-targeted at `LatestEdgeRow` (the unit that owns the conditional shape).
// ---------------------------------------------------------------------------
describe("LatestEdgeRow no-anchor → anchor transition preserves avatar DOM identity", () => {
  afterEach(() => {
    cleanup();
  });

  test("avatar instance is NOT remounted when the first anchor appears", async () => {
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
    const renderAvatar = () => <MountTracker />;

    const { rerender } = render(
      <LatestEdgeRow
        anchorMessage={null}
        responseItems={[]}
        hasAvatar
        renderAvatar={renderAvatar}
        viewportMinHeight={undefined}
        rowProps={rowProps}
      />,
    );
    expect(avatarMountCount).toBe(1);
    expect(avatarUnmountCount).toBe(0);

    // First user message lands → anchor lights up.
    await act(async () => {
      rerender(
        <LatestEdgeRow
          anchorMessage={userMessage("u1", "first user message")}
          responseItems={[]}
          hasAvatar
          renderAvatar={renderAvatar}
          viewportMinHeight={640}
          rowProps={rowProps}
        />,
      );
    });
    expect(avatarMountCount).toBe(1);
    expect(avatarUnmountCount).toBe(0);

    // Reverse direction: drop the anchor again. Avatar identity preserved.
    await act(async () => {
      rerender(
        <LatestEdgeRow
          anchorMessage={null}
          responseItems={[]}
          hasAvatar
          renderAvatar={renderAvatar}
          viewportMinHeight={undefined}
          rowProps={rowProps}
        />,
      );
    });
    expect(avatarMountCount).toBe(1);
    expect(avatarUnmountCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Transcript — row model wired into VirtualList (jsdom; see file header on why
// items don't paint here).
// ---------------------------------------------------------------------------

describe("Transcript (virtualized)", () => {
  afterEach(() => {
    cleanup();
  });

  test("mounts the VirtualList scroller for a non-empty transcript", () => {
    const items: MessageItem[] = [
      assistantMessage("a1", "reply"),
      userMessage("u1", "question"),
    ];
    const { container } = render(
      <Transcript items={items} conversationId="c1" onSurfaceAction={noop} />,
    );
    // VirtualList tags its scroll root with this slot; its presence proves the
    // row model is wired into the primitive even though items don't paint.
    expect(container.querySelector('[data-slot="virtual-list"]')).not.toBeNull();
  });

  test("scrollToMessage resolves loaded ids and rejects unknown ones", () => {
    const ref = createRef<TranscriptHandle>();
    const items: MessageItem[] = [
      assistantMessage("a1", "reply one"),
      userMessage("u1", "question one"),
      assistantMessage("a2", "reply two"),
      userMessage("u2", "latest question"),
    ];
    // partition: history [a1, u1, a2] (all registered in indexById) + anchor u2.
    render(
      <Transcript
        ref={ref}
        items={items}
        conversationId="c1"
        onSurfaceAction={noop}
      />,
    );

    // A loaded history message and the anchor resolve to a row index → true.
    expect(ref.current?.scrollToMessage("a1")).toBe(true);
    expect(ref.current?.scrollToMessage("u2")).toBe(true);
    // An id not present in the loaded window → false (the caller retries once
    // the older page loads).
    expect(ref.current?.scrollToMessage("not-loaded")).toBe(false);
  });

  test("scrollToMessage resolves a latest-turn response message (deep link to latest reply)", () => {
    // Regression: the composite latest-edge row renders the anchor user message
    // AND the streaming response inside LatestTurnRow. A deep link to the
    // latest assistant reply (a response item, not yet folded into history)
    // must resolve to the composite row rather than returning false and having
    // the caller give up + clear the URL.
    const ref = createRef<TranscriptHandle>();
    const items: MessageItem[] = [
      userMessage("u1", "latest question"),
      assistantMessage("a1", "latest reply"),
    ];
    // partition: history [], anchor u1, response [a1] (rendered in the composite).
    render(
      <Transcript
        ref={ref}
        items={items}
        conversationId="c1"
        onSurfaceAction={noop}
      />,
    );

    expect(ref.current?.scrollToMessage("u1")).toBe(true);
    expect(ref.current?.scrollToMessage("a1")).toBe(true);
  });
});

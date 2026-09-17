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

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, createRef, useEffect } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";

// `ChatMarkdownMessage` pulls in `react-markdown` + `remark-gfm`. They render
// fine under `renderToStaticMarkup`, but to keep these tests hermetic we
// replace it with a plain passthrough.
let markdownRenderCount = 0;
mock.module("@/domains/chat/components/chat-markdown-message", () => ({
  ChatMarkdownMessage: ({ content }: { content: string }) => {
    markdownRenderCount += 1;
    return <div data-testid="markdown">{content}</div>;
  },
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
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";
import type { ModeSessionDescriptor } from "@vellumai/assistant-api";
import type { SessionDisclosureState } from "@/domains/chat/transcript/use-session-disclosure-state";

import {
  textBody,
  thinkingBodyWithBlocks,
} from "@/domains/chat/utils/message-test-helpers";
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

function sessionMessage(
  item: TranscriptItem,
  mode: ModeSessionDescriptor["summary"]["mode"],
  id = "session-1",
): TranscriptItem {
  if (item.kind !== "message") {
    throw new Error("Expected message fixture");
  }
  return {
    ...item,
    message: { ...item.message, timestamp: 2_000, modeSession: { mode, id } },
  };
}

function controlledRegions(header: HTMLElement): HTMLElement[] {
  return (header.getAttribute("aria-controls") ?? "")
    .split(/\s+/)
    .map((id) => document.getElementById(id))
    .filter((region): region is HTMLElement => region !== null);
}

const noop = () => {};
const openDisclosure: SessionDisclosureState = {
  isSessionOpen: () => true,
  observeLiveSession: noop,
  setSessionOpen: noop,
};

function activeDescriptor(
  id: string,
  messageId = "a-session",
): ModeSessionDescriptor {
  return {
    summary: {
      id,
      conversationId: "conv-1",
      mode: "browser",
      sourceStartedAt: 1_000,
      firstIncludedAt: 1_000,
      firstIncludedMessageId: messageId,
      lastActivityAt: 2_000,
      lastOwnedMessageId: messageId,
      revision: 1,
      status: "active",
      endedAt: null,
      endReason: null,
    },
  };
}

function completedDescriptor(id: string): ModeSessionDescriptor {
  const active = activeDescriptor(id).summary;
  return {
    summary: {
      ...active,
      status: "completed",
      endedAt: 3_000,
      endReason: "completed",
    },
  };
}

afterEach(() => {
  cleanup();
  markdownRenderCount = 0;
  useAssistantFeatureFlagStore.setState({ sessionGroups: false });
});

describe("Transcript", () => {
  test("only the newest reply's thinking shimmers within a shared Live group", () => {
    const thinking = (id: string): TranscriptItem =>
      sessionMessage(
        {
          kind: "message",
          key: id,
          message: {
            id,
            role: "assistant",
            ...thinkingBodyWithBlocks("Considering the question"),
          },
        },
        "live_vision",
      );
    useTurnStore.setState({ phase: "streaming" });
    try {
      const { getAllByTestId, getByTestId, queryByTestId } = render(
        <Transcript
          items={[
            sessionMessage(userMessage("u1", "First question"), "live_vision"),
            thinking("a1"),
            sessionMessage(userMessage("u2", "Next question"), "live_vision"),
            thinking("a2"),
          ]}
          conversationId="conv-1"
          modeSessionDescriptors={[
            {
              summary: {
                ...activeDescriptor("session-1", "u1").summary,
                mode: "live_vision",
              },
            },
          ]}
          sessionGroupsEnabled
          sessionDisclosureState={openDisclosure}
          onSurfaceAction={noop}
        />,
      );
      expect(getAllByTestId("thought-process-link")).toHaveLength(2);
      expect(getAllByTestId("thought-process-loading")).toHaveLength(1);
      expect(
        getByTestId("thought-process-loading")
          .closest("[data-message-id]")
          ?.getAttribute("data-message-id"),
      ).toBe("a2");
      act(() => useTurnStore.setState({ phase: "idle" }));
      expect(queryByTestId("thought-process-loading")).toBeNull();
    } finally {
      useTurnStore.setState(INITIAL_TURN_STATE);
    }
  });

  test("keeps one active Live header across replies until that session ends", () => {
    const firstUser = sessionMessage(
      userMessage("u1", "First question"),
      "live_vision",
    );
    const firstReply = sessionMessage(
      assistantMessage("a1", "First answer"),
      "live_vision",
    );
    const nextUser = sessionMessage(
      userMessage("u2", "Next question"),
      "live_vision",
    );
    const nextReply = sessionMessage(
      assistantMessage("a2", "Next answer"),
      "live_vision",
    );
    const active: ModeSessionDescriptor = {
      summary: {
        ...activeDescriptor("session-1", "u1").summary,
        mode: "live_vision",
      },
    };
    const view = (
      items: TranscriptItem[],
      descriptors = [active],
      enabled = true,
    ) => (
      <Transcript
        items={items}
        conversationId="conv-1"
        modeSessionDescriptors={descriptors}
        sessionGroupsEnabled={enabled}
        sessionDisclosureState={openDisclosure}
        onSurfaceAction={noop}
      />
    );
    const { getAllByRole, getByText, queryByText, rerender } = render(
      view([firstUser, firstReply]),
    );
    const header = getAllByRole("button", { name: /Live vision session/ })[0]!;
    for (const items of [
      [firstUser, firstReply, nextUser],
      [firstUser, firstReply, nextUser, nextReply],
    ]) {
      rerender(view(items));
      const headers = getAllByRole("button", { name: /Live vision session/ });
      expect(headers).toHaveLength(1);
      expect(headers[0]).toBe(header);
      expect(header?.textContent).toContain("Working");
      expect(queryByText(/Ended/)).toBeNull();
      for (const text of ["Next question", "First answer"]) {
        expect(
          controlledRegions(header).some((region) =>
            region.contains(getByText(text)),
          ),
        ).toBe(true);
      }
    }
    const completed: ModeSessionDescriptor = {
      summary: {
        ...active.summary,
        status: "completed",
        revision: 2,
        endedAt: 3_000,
        endReason: "camera_session_ended",
      },
    };
    const items = [firstUser, firstReply, nextUser, nextReply];
    rerender(view(items, [completed]));
    expect(
      getAllByRole("button", { name: /Live vision session/ }),
    ).toHaveLength(1);
    expect(getAllByRole("button", { name: /Live vision session/ })[0]).toBe(
      header,
    );
    expect(header?.textContent).toContain("Ended");

    const restarted = sessionMessage(
      userMessage("u3", "Restarted camera"),
      "live_vision",
      "session-2",
    );
    const restartedReply = sessionMessage(
      assistantMessage("a3", "New camera answer"),
      "live_vision",
      "session-2",
    );
    const restartedDescriptor: ModeSessionDescriptor = {
      summary: {
        ...active.summary,
        id: "session-2",
        firstIncludedMessageId: "u3",
        lastOwnedMessageId: "a3",
      },
    };
    rerender(
      view(
        [...items, restarted, restartedReply],
        [completed, restartedDescriptor],
      ),
    );
    const headers = getAllByRole("button", { name: /Live vision session/ });
    expect(headers).toHaveLength(2);
    expect(headers[0]?.textContent).toContain("Ended");
    expect(headers[1]?.textContent).toContain("Working");

    rerender(view(items, [completed], false));
    expect(queryByText("Live vision session")).toBeNull();
    for (const text of [
      "First question",
      "First answer",
      "Next question",
      "Next answer",
    ]) {
      expect(getByText(text).closest("[data-session-mode]")).toBeNull();
    }
  });

  test.each(["browser", "computer_use"] as const)(
    "%s keeps a stamped structural response inside its group before the next reply",
    (mode) => {
      const first = sessionMessage(
        assistantMessage("a1", "Choose an option"),
        mode,
      );
      const answer = sessionMessage(userMessage("u2", "Chosen option"), mode);
      const reply = sessionMessage(
        assistantMessage("a2", "Continuing the task"),
        mode,
      );
      const descriptor: ModeSessionDescriptor = {
        summary: { ...activeDescriptor("session-1", "a1").summary, mode },
      };
      const view = (items: TranscriptItem[]) => (
        <Transcript
          items={items}
          conversationId="conv-1"
          modeSessionDescriptors={[descriptor]}
          sessionGroupsEnabled
          sessionDisclosureState={openDisclosure}
          onSurfaceAction={noop}
        />
      );
      const { getByText, getAllByTestId, rerender } = render(
        view([first, answer]),
      );
      const header = getAllByTestId("session-group-trigger").find(
        (trigger) => !trigger.hidden,
      )!;
      for (const text of ["Choose an option", "Chosen option"]) {
        expect(
          controlledRegions(header).some((region) =>
            region.contains(getByText(text)),
          ),
        ).toBe(true);
      }
      expect(
        getAllByTestId("session-group-trigger").filter(
          (trigger) => !trigger.hidden,
        ),
      ).toHaveLength(1);
      rerender(view([first, answer, reply]));
      expect(
        controlledRegions(header).some((region) =>
          region.contains(getByText("Continuing the task")),
        ),
      ).toBe(true);
      expect(
        getAllByTestId("session-group-trigger").filter(
          (trigger) => !trigger.hidden,
        ),
      ).toHaveLength(1);
      rerender(
        view([first, answer, reply, userMessage("u3", "Unrelated question")]),
      );
      const settledHeader = getAllByTestId("session-group-trigger").find(
        (trigger) => !trigger.hidden,
      )!;
      expect(
        controlledRegions(settledHeader).some((region) =>
          region.contains(getByText("Unrelated question")),
        ),
      ).toBe(false);
      expect(
        controlledRegions(settledHeader).some((region) =>
          region.contains(getByText("Chosen option")),
        ),
      ).toBe(true);
    },
  );

  test("keeps the session prefix above the latest viewport and closes only owned content", () => {
    const view = (includeTrailing: boolean) => (
      <Transcript
        items={[
          sessionMessage(userMessage("u1", "Earlier question"), "live_vision"),
          sessionMessage(
            assistantMessage("a1", "Earlier answer"),
            "live_vision",
          ),
          sessionMessage(userMessage("u2", "Current question"), "live_vision"),
          sessionMessage(
            assistantMessage("a2", "Current answer"),
            "live_vision",
          ),
          ...(includeTrailing
            ? [
                assistantMessage("unowned", "Independent reply"),
                {
                  kind: "thinking",
                  key: "pending-work",
                  active: true,
                  label: "Pending work",
                } satisfies TranscriptItem,
              ]
            : []),
        ]}
        conversationId="conv-1"
        modeSessionDescriptors={[
          {
            summary: {
              ...activeDescriptor("session-1", "u1").summary,
              mode: "live_vision",
            },
          },
        ]}
        sessionGroupsEnabled
        onSurfaceAction={noop}
        renderAvatar={() => <span>Avatar marker</span>}
      />
    );
    const { container, getByRole, getByText, queryByText, rerender } = render(
      view(true),
    );
    const header = getByRole("button", { name: /Live vision session/ });
    fireEvent.click(header);
    const regions = controlledRegions(header);
    expect(regions).toHaveLength(2);
    for (const region of regions) {
      expect(region.getAttribute("aria-labelledby")).toBe(header.id);
    }
    const sentinel = container.querySelector('[data-latest-edge="true"]')!;
    const viewport = sentinel.parentElement!;
    const avatar = container.querySelector(
      '[data-latest-assistant-avatar="true"]',
    )!;
    const spacer = container.querySelector('[data-latest-edge-spacer="true"]')!;
    const independent = getByText("Independent reply");
    const pending = getByText("Pending work");
    expect(viewport.style.minHeight).not.toBe("");
    expect(viewport.contains(header)).toBe(false);
    expect(viewport.contains(getByText("Earlier answer"))).toBe(false);
    expect(
      viewport
        .querySelector("[data-message-id]")
        ?.getAttribute("data-message-id"),
    ).toBe("u2");
    for (const node of [independent, pending]) {
      expect(viewport.contains(node)).toBe(true);
      expect(regions.some((region) => region.contains(node))).toBe(false);
    }
    for (const open of [false, true]) {
      fireEvent.click(header);
      expect(header.getAttribute("aria-expanded")).toBe(String(open));
      expect(viewport.style.minHeight !== "").toBe(open);
      for (const text of [
        "Earlier question",
        "Earlier answer",
        "Current question",
        "Current answer",
      ]) {
        expect(queryByText(text) !== null).toBe(open);
      }
      expect(getByText("Independent reply")).toBe(independent);
      expect(getByText("Pending work")).toBe(pending);
      for (const node of [independent, pending]) {
        expect(node.closest('[hidden], [aria-hidden="true"]')).toBeNull();
      }
      for (const [selector, node] of [
        ['[data-latest-assistant-avatar="true"]', avatar],
        ['[data-latest-edge-spacer="true"]', spacer],
        ['[data-latest-edge="true"]', sentinel],
      ] as const) {
        expect(container.querySelectorAll(selector)).toHaveLength(1);
        expect(container.querySelector(selector)).toBe(node);
      }
    }
    rerender(view(false));
    expect(queryByText("Independent reply")).toBeNull();
    expect(queryByText("Pending work")).toBeNull();
    for (const open of [false, true]) {
      fireEvent.click(header);
      expect(viewport.style.minHeight !== "").toBe(open);
      expect(queryByText("Current question") !== null).toBe(open);
      expect(container.querySelector('[data-latest-edge-spacer="true"]')).toBe(
        spacer,
      );
    }
  });

  test("keeps the latest reply DOM mounted while its session header appears", () => {
    const anchor = userMessage("u-session", "Open the page");
    const response = assistantMessage("a-session", "Session reply");
    const { getByText, queryByRole, rerender } = render(
      <Transcript
        items={[anchor, response]}
        conversationId="conv-1"
        sessionGroupsEnabled
        sessionDisclosureState={openDisclosure}
        onSurfaceAction={noop}
      />,
    );
    const replyNode = getByText("Session reply").closest("[data-message-id]");
    expect(queryByRole("button", { name: /Browser session/ })).toBeNull();

    if (response.kind !== "message") {
      throw new Error("Expected message fixture");
    }
    const stampedResponse: TranscriptItem = {
      ...response,
      message: {
        ...response.message,
        timestamp: 2_000,
        modeSession: { mode: "browser", id: "session-1" },
      },
    };
    rerender(
      <Transcript
        items={[anchor, stampedResponse]}
        conversationId="conv-1"
        modeSessionDescriptors={[activeDescriptor("session-1")]}
        sessionGroupsEnabled
        sessionDisclosureState={openDisclosure}
        onSurfaceAction={noop}
      />,
    );

    expect(getByText("Session reply").closest("[data-message-id]")).toBe(
      replyNode,
    );
    expect(queryByRole("button", { name: /Browser session/ })).toBeTruthy();
  });

  test("opens a closed recorded group before a deep-link retry scrolls", () => {
    const ref = createRef<import("./transcript").TranscriptHandle>();
    const stamped = assistantMessage("a-session", "Recorded reply");
    if (stamped.kind !== "message") {
      throw new Error("Expected message fixture");
    }
    stamped.message.timestamp = 2_000;
    stamped.message.modeSession = { mode: "browser", id: "session-1" };
    const { queryByText } = render(
      <Transcript
        ref={ref}
        items={[stamped]}
        conversationId="conv-1"
        modeSessionDescriptors={[completedDescriptor("session-1")]}
        sessionGroupsEnabled
        onSurfaceAction={noop}
      />,
    );

    expect(queryByText("Recorded reply")).toBeNull();
    let found = true;
    act(() => {
      found = ref.current?.scrollToMessage("a-session") ?? true;
    });
    expect(found).toBe(false);
    expect(queryByText("Recorded reply")).toBeTruthy();
  });

  test("resolves an optimistic nonce when revealing and retrying a collapsed target", () => {
    const ref = createRef<import("./transcript").TranscriptHandle>();
    const stamped = assistantMessage("server-1", "Optimistic reply");
    if (stamped.kind !== "message") {
      throw new Error("Expected message fixture");
    }
    stamped.message.clientMessageId = "nonce-1";
    stamped.message.timestamp = 2_000;
    stamped.message.modeSession = { mode: "browser", id: "session-1" };
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = mock(() => {});
    try {
      const { queryByText } = render(
        <Transcript
          ref={ref}
          items={[stamped]}
          conversationId="conv-1"
          modeSessionDescriptors={[
            {
              summary: {
                ...completedDescriptor("session-1").summary,
                firstIncludedMessageId: "server-1",
                lastOwnedMessageId: "server-1",
              },
            },
          ]}
          sessionGroupsEnabled
          onSurfaceAction={noop}
        />,
      );

      let found = true;
      act(() => {
        found = ref.current?.scrollToMessage("nonce-1") ?? true;
      });
      expect(found).toBe(false);
      expect(queryByText("Optimistic reply")).toBeTruthy();

      act(() => {
        found = ref.current?.scrollToMessage("nonce-1") ?? false;
      });
      expect(found).toBe(true);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  test("commits a default-closed alias reveal before running anchor correction", () => {
    const ref = createRef<import("./transcript").TranscriptHandle>();
    const stamped = assistantMessage("server-1", "Preserved anchor reply");
    if (stamped.kind !== "message") {
      throw new Error("Expected message fixture");
    }
    stamped.message.mergedMessageIds = ["saved-alias"];
    stamped.message.timestamp = 2_000;
    stamped.message.modeSession = { mode: "browser", id: "session-1" };
    const revealed = mock(() => {});
    const { queryByText } = render(
      <Transcript
        ref={ref}
        items={[stamped]}
        conversationId="conv-1"
        modeSessionDescriptors={[
          {
            summary: {
              ...completedDescriptor("session-1").summary,
              firstIncludedMessageId: "saved-alias",
              lastOwnedMessageId: "saved-alias",
            },
          },
        ]}
        sessionGroupsEnabled
        onSurfaceAction={noop}
      />,
    );

    expect(queryByText("Preserved anchor reply")).toBeNull();
    let requested = false;
    act(() => {
      requested =
        ref.current?.revealMessage?.("saved-alias", revealed) ?? false;
    });
    expect(requested).toBe(true);
    expect(queryByText("Preserved anchor reply")).toBeTruthy();
    expect(revealed).toHaveBeenCalledTimes(1);
  });

  test("shares one clock across mounted active headers without observing visibility", () => {
    const originalObserver = globalThis.IntersectionObserver;
    let observerCount = 0;
    globalThis.IntersectionObserver = class implements IntersectionObserver {
      root = null;
      rootMargin = "0px";
      thresholds = [0];
      constructor() {
        observerCount += 1;
      }
      disconnect() {}
      observe() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    };
    let tick: (() => void) | undefined;
    const interval = spyOn(globalThis, "setInterval").mockImplementation(((
      callback: TimerHandler,
    ) => {
      tick = callback as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);
    const clear = spyOn(globalThis, "clearInterval").mockImplementation(
      () => {},
    );
    let now = 4_000;
    const dateNow = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const first = assistantMessage("a-one", "First active reply");
      const second = assistantMessage("a-two", "Closed waiting reply");
      for (const [item, id] of [
        [first, "session-1"],
        [second, "session-2"],
      ] as const) {
        if (item.kind === "message") {
          item.message.timestamp = 2_000;
          item.message.modeSession = { mode: "browser", id };
        }
      }
      const descriptors = [
        activeDescriptor("session-1", "a-one"),
        {
          ...activeDescriptor("session-2", "a-two"),
          runtimeState: "waiting" as const,
        },
      ];
      const disclosure = {
        ...openDisclosure,
        isSessionOpen: (id: string) => id === "session-1",
      };
      const view = (items: TranscriptItem[]) => (
        <Transcript
          items={items}
          conversationId="conv-1"
          modeSessionDescriptors={descriptors}
          sessionGroupsEnabled
          sessionDisclosureState={disclosure}
          onSurfaceAction={noop}
        />
      );
      const { getByText, queryByText, getAllByRole, rerender, unmount } =
        render(view([first, second]));
      const headers = getAllByRole("button", { name: /Browser session/ });
      expect(headers).toHaveLength(2);
      expect(queryByText("Closed waiting reply")).toBeNull();
      expect(interval).toHaveBeenCalledTimes(1);
      const bodyRenders = markdownRenderCount;
      now += 1_000;
      act(() => tick?.());
      expect(markdownRenderCount).toBe(bodyRenders);
      if (first.kind !== "message") {
        throw new Error("Expected message fixture");
      }
      for (let i = 0; i < 10; i += 1) {
        rerender(
          view([
            {
              ...first,
              message: {
                ...first.message,
                ...textBody(`Stream ${i}`),
              },
            },
            second,
          ]),
        );
        expect(getByText(`Stream ${i}`)).toBeTruthy();
        expect(getAllByRole("button", { name: /Browser session/ })[0]).toBe(
          headers[0],
        );
      }
      expect(observerCount).toBe(0);
      expect(interval).toHaveBeenCalledTimes(1);
      unmount();
      expect(clear).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
      globalThis.IntersectionObserver = originalObserver;
      interval.mockRestore();
      clear.mockRestore();
      dateNow.mockRestore();
    }
  });

  test("uses the assistant flag and avoids session observers while it is off", () => {
    const originalIntersectionObserver = globalThis.IntersectionObserver;
    let observerCount = 0;
    globalThis.IntersectionObserver = class implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
      constructor() {
        observerCount += 1;
      }
      disconnect() {}
      observe() {}
      takeRecords() {
        return [];
      }
      unobserve() {}
    };
    const interval = spyOn(globalThis, "setInterval");
    const stamped = assistantMessage("a-session", "Flat reply");
    if (stamped.kind !== "message") {
      throw new Error("Expected message fixture");
    }
    stamped.message.modeSession = { mode: "browser", id: "session-1" };
    try {
      const { getByText, queryByRole } = render(
        <Transcript
          items={[stamped]}
          conversationId="conv-1"
          modeSessionDescriptors={[activeDescriptor("session-1", "a-session")]}
          onSurfaceAction={noop}
        />,
      );

      expect(getByText("Flat reply")).toBeTruthy();
      expect(queryByRole("button", { name: /Browser session/ })).toBeNull();
      expect(observerCount).toBe(0);
      expect(interval).not.toHaveBeenCalled();
    } finally {
      globalThis.IntersectionObserver = originalIntersectionObserver;
      interval.mockRestore();
    }
  });

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

/**
 * Tests for `MobileChatInfoOverlay`, the mobile full-screen host for the
 * chat-info panel.
 *
 * The panel itself is stubbed: what the host owns is whether it renders at
 * all, and whether a conversation switch remounts what it hosts rather than
 * feeding a new payload into a panel still holding the previous chat's
 * preview and delete state.
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
import { cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";

import type * as ChatInfoPanelModule from "@/domains/chat/components/chat-info-panel";
import type { ChatInfoPayload } from "@/stores/viewer-store";

let mountCount = 0;

mock.module(
  "@/domains/chat/components/chat-info-panel",
  (): Partial<typeof ChatInfoPanelModule> => ({
    ChatInfoPanel: ({ payload }) => {
      useEffect(() => {
        mountCount += 1;
      }, []);
      return (
        <div
          data-testid={`panel-${payload.assistantId}-${payload.conversationId}`}
        >
          {payload.conversationId}
        </div>
      );
    },
  }),
);

const { MobileChatInfoOverlay } =
  await import("@/domains/chat/components/mobile-chat-info-overlay");

const noop = () => {};

// The panel is lazy-loaded behind a LazyBoundary, so first paint can exceed
// findBy's 1000ms default under CI load.
const LAZY_WAIT = { timeout: 5000 };

function makePayload(
  conversationId: string,
  assistantId = "assistant-1",
): ChatInfoPayload {
  return { assistantId, conversationId, category: null };
}

beforeEach(() => {
  mountCount = 0;
});
afterEach(cleanup);
afterAll(() => mock.restore());

describe("MobileChatInfoOverlay", () => {
  test("renders nothing when payload is null", () => {
    const { container } = render(
      <MobileChatInfoOverlay
        payload={null}
        onClose={noop}
        onSelectCategory={noop}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("renders the panel when given a payload", async () => {
    render(
      <MobileChatInfoOverlay
        payload={makePayload("conv-1")}
        onClose={noop}
        onSelectCategory={noop}
      />,
    );
    expect(
      await screen.findByTestId(
        "panel-assistant-1-conv-1",
        undefined,
        LAZY_WAIT,
      ),
    ).toBeDefined();
  });

  test("switching conversation remounts the panel", async () => {
    const { rerender } = render(
      <MobileChatInfoOverlay
        payload={makePayload("conv-1")}
        onClose={noop}
        onSelectCategory={noop}
      />,
    );
    await screen.findByTestId("panel-assistant-1-conv-1", undefined, LAZY_WAIT);
    expect(mountCount).toBe(1);

    rerender(
      <MobileChatInfoOverlay
        payload={makePayload("conv-2")}
        onClose={noop}
        onSelectCategory={noop}
      />,
    );
    await screen.findByTestId("panel-assistant-1-conv-2", undefined, LAZY_WAIT);
    expect(screen.queryByTestId("panel-assistant-1-conv-1")).toBeNull();
    expect(mountCount).toBe(2);
  });

  test("switching assistant remounts the panel for the same conversation id", async () => {
    const { rerender } = render(
      <MobileChatInfoOverlay
        payload={makePayload("conv-1")}
        onClose={noop}
        onSelectCategory={noop}
      />,
    );
    await screen.findByTestId("panel-assistant-1-conv-1", undefined, LAZY_WAIT);

    rerender(
      <MobileChatInfoOverlay
        payload={makePayload("conv-1", "assistant-2")}
        onClose={noop}
        onSelectCategory={noop}
      />,
    );
    await screen.findByTestId("panel-assistant-2-conv-1", undefined, LAZY_WAIT);
    expect(screen.queryByTestId("panel-assistant-1-conv-1")).toBeNull();
    expect(mountCount).toBe(2);
  });
});

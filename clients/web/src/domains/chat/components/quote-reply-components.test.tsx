import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";

import { QuoteReplyBubble } from "@/domains/chat/components/quote-reply-bubble";
import { StagedQuotesStrip } from "@/domains/chat/components/staged-quotes-strip";
import { TextSelectionPopover } from "@/domains/chat/components/text-selection-popover";
import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";

function resetQuoteReplyState() {
  useQuoteReplyStore.setState({
    stagedQuotes: [],
    replyBubble: null,
  });
}

function installFinePointer() {
  const originalMatchMedia = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  return () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  };
}

function installCoarsePointer() {
  const originalMatchMedia = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: true }),
  });
  return () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  };
}

function installImmediateAnimationFrame() {
  const originalAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  }) as typeof requestAnimationFrame;
  return () => {
    globalThis.requestAnimationFrame = originalAnimationFrame;
  };
}

function installSelection(
  anchorNode: Node,
  rect: DOMRect = {
    top: 120,
    left: 80,
    width: 160,
    height: 24,
    right: 240,
    bottom: 144,
    x: 80,
    y: 120,
    toJSON: () => ({}),
  },
) {
  const originalGetSelection = window.getSelection;
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode,
    toString: () => "competitive research",
    getRangeAt: () => ({
      getBoundingClientRect: () => rect,
    }),
    removeAllRanges: () => {},
  } as unknown as Selection;

  Object.defineProperty(window, "getSelection", {
    configurable: true,
    value: () => selection,
  });

  return () => {
    Object.defineProperty(window, "getSelection", {
      configurable: true,
      value: originalGetSelection,
    });
  };
}

function installViewportHeight(innerHeight: number) {
  const originalInnerHeight = window.innerHeight;
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: innerHeight,
  });
  return () => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  };
}

beforeEach(resetQuoteReplyState);
afterEach(() => {
  cleanup();
  resetQuoteReplyState();
});

describe("TextSelectionPopover", () => {
  test("shows a design-system Reply action for assistant text selections", async () => {
    const restorePointer = installFinePointer();
    const restoreAnimationFrame = installImmediateAnimationFrame();
    try {
      const containerRef = createRef<HTMLDivElement | null>();
      render(
        <>
          <div ref={containerRef}>
            <div data-message-id="msg-1" data-message-role="assistant">
              <span data-testid="selected-text">competitive research</span>
            </div>
          </div>
          <TextSelectionPopover containerRef={containerRef} />
        </>,
      );

      const selectedText = screen.getByTestId("selected-text");
      const restoreSelection = installSelection(
        selectedText.firstChild ?? selectedText,
      );
      try {
        fireEvent.mouseUp(selectedText);
      } finally {
        restoreSelection();
      }

      const button = await screen.findByRole("button", { name: "Reply" });
      const popoverContent = document.body.querySelector(
        '[data-slot="popover-content"]',
      );
      expect(button.getAttribute("data-slot")).toBe("button");
      expect(popoverContent).toBeTruthy();
      expect(popoverContent?.className).not.toContain("bg-transparent");
      expect(popoverContent?.className).not.toContain("shadow-none");
      expect(screen.queryByRole("button", { name: "Quote & Reply" })).toBeNull();
    } finally {
      restoreAnimationFrame();
      restorePointer();
    }
  });

  test("shows Reply below coarse-pointer text selections", async () => {
    const restorePointer = installCoarsePointer();
    const restoreAnimationFrame = installImmediateAnimationFrame();
    try {
      const containerRef = createRef<HTMLDivElement | null>();
      render(
        <>
          <div ref={containerRef}>
            <div data-message-id="msg-1" data-message-role="assistant">
              <span data-testid="selected-text">competitive research</span>
            </div>
          </div>
          <TextSelectionPopover containerRef={containerRef} />
        </>,
      );

      const selectedText = screen.getByTestId("selected-text");
      const restoreSelection = installSelection(
        selectedText.firstChild ?? selectedText,
      );
      try {
        document.dispatchEvent(new Event("selectionchange"));
        await screen.findByRole("button", { name: "Reply" });
      } finally {
        restoreSelection();
      }

      const popoverContent = document.body.querySelector(
        '[data-slot="popover-content"]',
      );
      expect(popoverContent?.getAttribute("data-selection-placement")).toBe(
        "bottom",
      );
    } finally {
      restoreAnimationFrame();
      restorePointer();
    }
  });

  test("moves coarse-pointer Reply above selections when there is no space below", async () => {
    const restorePointer = installCoarsePointer();
    const restoreAnimationFrame = installImmediateAnimationFrame();
    const restoreViewportHeight = installViewportHeight(160);
    try {
      const containerRef = createRef<HTMLDivElement | null>();
      render(
        <>
          <div ref={containerRef}>
            <div data-message-id="msg-1" data-message-role="assistant">
              <span data-testid="selected-text">competitive research</span>
            </div>
          </div>
          <TextSelectionPopover containerRef={containerRef} />
        </>,
      );

      const selectedText = screen.getByTestId("selected-text");
      const restoreSelection = installSelection(
        selectedText.firstChild ?? selectedText,
      );
      try {
        document.dispatchEvent(new Event("selectionchange"));
        await screen.findByRole("button", { name: "Reply" });
      } finally {
        restoreSelection();
      }

      const popoverContent = document.body.querySelector(
        '[data-slot="popover-content"]',
      );
      expect(popoverContent?.getAttribute("data-selection-placement")).toBe(
        "top",
      );
    } finally {
      restoreViewportHeight();
      restoreAnimationFrame();
      restorePointer();
    }
  });
});

describe("QuoteReplyBubble", () => {
  test("renders the reply editor with only Add to Chat", async () => {
    useQuoteReplyStore.setState({
      replyBubble: {
        quotedText:
          "here's the anthropic competitive research brief from last night",
        sourceMessageId: "msg-1",
        anchorRect: { top: 120, left: 180, width: 0, height: 0 },
      },
    });

    render(<QuoteReplyBubble />);

    await waitFor(() => {
      expect(
        document.body.querySelector('[data-slot="popover-content"]'),
      ).toBeTruthy();
    });
    expect(document.body.querySelector('[data-slot="card"]')).toBeTruthy();
    expect(document.body.querySelector('[data-slot="textarea"]')).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Close reply" }).getAttribute("data-slot"),
    ).toBe("button");
    expect(
      screen.getByRole("button", { name: "Add to Chat" }).getAttribute("data-slot"),
    ).toBe("button");
    expect(screen.queryByRole("button", { name: "Send Now" })).toBeNull();
  });

  test("Enter stages the reply, closes the bubble, and focuses the composer", async () => {
    const composerInput = document.createElement("textarea");
    document.body.appendChild(composerInput);
    useQuoteReplyStore.setState({
      replyBubble: {
        quotedText: "quoted context",
        sourceMessageId: "msg-1",
        anchorRect: { top: 120, left: 180, width: 0, height: 0 },
      },
    });

    render(
      <QuoteReplyBubble
        onAddToChat={() => composerInput.focus()}
      />,
    );

    const replyInput = await screen.findByPlaceholderText("Type your reply…");
    fireEvent.change(replyInput, { target: { value: "use this context" } });
    fireEvent.keyDown(replyInput, { key: "Enter", shiftKey: false });

    expect(useQuoteReplyStore.getState().stagedQuotes).toMatchObject([
      {
        quotedText: "quoted context",
        replyText: "use this context",
        sourceMessageId: "msg-1",
      },
    ]);
    await waitFor(() => {
      expect(screen.queryByPlaceholderText("Type your reply…")).toBeNull();
    });
    expect(document.activeElement).toBe(composerInput);
  });
});

describe("StagedQuotesStrip", () => {
  test("renders staged quote previews with shared card and button primitives", () => {
    useQuoteReplyStore.setState({
      stagedQuotes: [
        {
          id: "quote-1",
          quotedText: "competitive research",
          replyText: "Can you expand this into a brief?",
          sourceMessageId: "msg-1",
        },
      ],
    });

    render(<StagedQuotesStrip />);

    expect(document.body.querySelector('[data-slot="card"]')).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove quote" }).getAttribute("data-slot"),
    ).toBe("button");
  });
});

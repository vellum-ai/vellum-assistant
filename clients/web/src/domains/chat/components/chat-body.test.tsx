/**
 * Tests for the `ChatBody` layout behavior.
 *
 * Verifies the conditional CSS class logic and slot rendering that
 * enables centered empty-state layout (LUM-1566): greeting + composer +
 * conversation-starter chips center as one visual group via
 * `justify-content: safe center`.
 *
 * Uses bun:test + react-dom/server (renderToStaticMarkup) matching the
 * existing project test convention. Complex child components are stubbed
 * via `mock.module` so the test focuses on the composition logic inside
 * `ChatBody` itself.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { type ButtonHTMLAttributes, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ChatBodyProps } from "@/domains/chat/components/chat-body";
import { useBannerVisibilityStore } from "@/stores/banner-visibility-store";

// Stub child components that require browser APIs or complex hooks.
// NOTE: Do NOT mock chat-scroll-area itself — that leaks across test
// files via bun's shared module registry and breaks chat-scroll-area's
// own tests. Instead, mock ChatScrollArea's deep dependencies.
mock.module("@/domains/chat/transcript/transcript", () => ({
  Transcript: () => <div data-testid="transcript">TRANSCRIPT</div>,
}));

mock.module("@/domains/chat/components/maintenance-recovery-card", () => ({
  MaintenanceRecoveryCard: () => <div>MAINTENANCE</div>,
}));

mock.module("@/domains/chat/components/chat-skeleton", () => ({
  ChatSkeleton: () => <div>SKELETON</div>,
}));

mock.module("@/domains/chat/components/scroll-to-latest-button", () => ({
  ScrollToLatestButton: ({ onClick }: { onClick: () => void }) => (
    <button data-testid="scroll-to-latest" onClick={onClick}>
      SCROLL_TO_LATEST
    </button>
  ),
}));

mock.module("@vellumai/design-library", () => ({
  Button: ({
    children,
    iconOnly,
    leftIcon: _leftIcon,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children?: ReactNode;
    iconOnly?: ReactNode;
    leftIcon?: ReactNode;
    variant?: string;
    size?: string;
  } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{iconOnly ?? children}</button>
  ),
  Notice: ({
    children,
    actions,
    tone,
    onDismiss,
  }: {
    children?: ReactNode;
    actions?: ReactNode;
    tone?: string;
    onDismiss?: () => void;
  }) => (
    <div data-testid="notice" data-tone={tone}>
      {children}
      {actions ? <div data-testid="notice-actions">{actions}</div> : null}
      {onDismiss ? (
        <button
          type="button"
          aria-label="Dismiss"
          data-testid="notice-dismiss"
          onClick={onDismiss}
        />
      ) : null}
    </div>
  ),
  Card: {
    Root: ({
      children,
      padding: _padding,
      bordered: _bordered,
      elevated: _elevated,
      ...props
    }: {
      children?: ReactNode;
      padding?: unknown;
      bordered?: unknown;
      elevated?: unknown;
    }) => <div {...props}>{children}</div>,
    Body: ({
      children,
      padding: _padding,
      ...props
    }: {
      children?: ReactNode;
      padding?: unknown;
    }) => <div {...props}>{children}</div>,
  },
  ResizablePanel: () => <div data-testid="resizable-panel" />,
  ScrollShadow: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  Typography: ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  ),
}));

mock.module("@/domains/chat/refresh-feedback-pill", () => ({
  RefreshFeedbackPill: () => <div>REFRESH_PILL</div>,
}));

mock.module("@/domains/chat/components/question-prompt-slot", () => ({
  QuestionPromptSlot: () => <div data-testid="question-prompt-slot" />,
}));

let keyboardOpen = false;
mock.module("@/hooks/use-keyboard-open", () => ({
  useKeyboardOpen: () => keyboardOpen,
}));

// Import after mocks are registered.
const { ChatBody } = await import("@/domains/chat/components/chat-body");

const noop = () => {};
const noopDrag = () => {};

function baseProps(overrides: Partial<ChatBodyProps> = {}): ChatBodyProps {
  return {
    variant: "main",
    scrollAreaProps: {
      isLoadingHistory: false,
      messageCount: 0,
      showMaintenanceRecoveryCard: false,
      showEmptyState: false,
      emptyStateProps: {},
      transcriptRef: null,
      transcriptProps: { messages: [], onScrollToMessage: noop } as never,
    },
    composerSlot: <div data-testid="composer">COMPOSER</div>,
    dragHandlers: {
      onDragEnter: noopDrag,
      onDragOver: noopDrag,
      onDragLeave: noopDrag,
      onDrop: noopDrag,
    },
    isAttachmentDragOver: false,
    showScrollToLatest: false,
    onScrollToLatest: noop,
    refreshFeedback: null,
    onDismissRefreshFeedback: noop,
    onRetryRefresh: noop,
    genericChatError: null,
    ...overrides,
  };
}

function withEmptyState(overrides: Partial<ChatBodyProps> = {}): ChatBodyProps {
  return baseProps({
    scrollAreaProps: {
      ...baseProps().scrollAreaProps,
      showEmptyState: true,
    },
    ...overrides,
  });
}

describe("ChatBody — empty-state centering (LUM-1566)", () => {
  test("applies safe_center and overflow-y-auto when empty state is visible", () => {
    const html = renderToStaticMarkup(<ChatBody {...withEmptyState()} />);
    expect(html).toContain("[justify-content:safe_center]");
    expect(html).toContain("overflow-y-auto");
  });

  test("does NOT apply safe_center or overflow-y-auto when empty state is hidden", () => {
    const html = renderToStaticMarkup(<ChatBody {...baseProps()} />);
    expect(html).not.toContain("[justify-content:safe_center]");
    expect(html).not.toContain("overflow-y-auto");
  });

  test("uses flex-1 in outer class for main variant", () => {
    const html = renderToStaticMarkup(
      <ChatBody {...baseProps({ variant: "main" })} />,
    );
    // The outer container class for the main variant.
    expect(html).toContain("relative flex min-h-0 flex-1 flex-col");
  });

  test("uses h-full in outer class for side-panel variant", () => {
    const html = renderToStaticMarkup(
      <ChatBody {...baseProps({ variant: "side-panel" })} />,
    );
    // The outer container class for the side-panel variant.
    expect(html).toContain("relative flex h-full min-h-0 flex-col");
  });
});

describe("ChatBody — banner overlay suppression (LUM-1566)", () => {
  test("suppresses banner overlay on empty state to prevent greeting overlap", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...withEmptyState({
          bannerSlot: <div data-testid="banner">BANNER_CONTENT</div>,
        })}
      />,
    );
    // The banner node is passed but the overlay container should not
    // render it on the empty state — it would overlap the greeting.
    expect(html).not.toContain("BANNER_CONTENT");
  });

  test("renders banner overlay when empty state is hidden and bannerSlot is provided", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          bannerSlot: <div data-testid="banner">BANNER_CONTENT</div>,
        })}
      />,
    );
    expect(html).toContain("BANNER_CONTENT");
  });

  test("the banner takes its space in flow, and only the pill floats", () => {
    // The banner is an opaque full-width card that always occupies its own
    // height, so it belongs in the flex column: the `flex-1` scroll area
    // gives back exactly that height at every viewport size. Positioning it
    // absolutely removes it from flow and forces the space to be measured
    // and reserved in JS, which is what put this component in the error-185
    // family (LUM-2927) and cost a ResizeObserver, a state, and a prop on
    // ChatScrollArea. The pill is the opposite: it genuinely floats over the
    // transcript and reserves nothing.
    const { container } = render(
      <ChatBody
        {...baseProps({
          showScrollToLatest: true,
          bannerSlot: <div data-testid="banner">BANNER_CONTENT</div>,
        })}
      />,
    );
    try {
      const banner = container.querySelector('[data-testid="banner"]');
      const pill = container.querySelector('[data-testid="scroll-to-latest"]');
      expect(banner).not.toBeNull();
      expect(pill).not.toBeNull();

      // In flow: no positioned ancestor between the banner and the root.
      expect(banner?.closest(".absolute")).toBeNull();
      // Floating: the pill still lives in a positioned, click-through layer.
      expect(pill?.closest(".absolute")).not.toBeNull();
      expect(pill?.closest(".pointer-events-none")).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test("measures nothing: no ResizeObserver, at mount or across re-renders", () => {
    // The structural invariant. Any reintroduction of measure-to-reserve
    // here (a ref'd node, an observer, a height in state) fails this, as
    // does the subtler regression Codex caught on the first attempt: two
    // unkeyed sibling divs in one overlay, where mounting the pill lets
    // React reuse the observed banner node and leaves the observer on the
    // wrong element.
    const originalResizeObserver = globalThis.ResizeObserver;
    let observersConstructed = 0;

    globalThis.ResizeObserver = class {
      constructor() {
        observersConstructed += 1;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;

    try {
      const { rerender } = render(
        <ChatBody
          {...baseProps({
            bannerSlot: <div data-testid="banner">BANNER_CONTENT</div>,
          })}
        />,
      );

      // Toggle the pill on and off under a live banner: the case that broke.
      for (const showScrollToLatest of [true, false, true]) {
        rerender(
          <ChatBody
            {...baseProps({
              showScrollToLatest,
              bannerSlot: <div data-testid="banner">BANNER_CONTENT</div>,
            })}
          />,
        );
      }

      expect(observersConstructed).toBe(0);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
      cleanup();
    }
  });
});

describe("ChatBody — banner-visibility store mirroring", () => {
  // The shared store must reflect the banner actually being MOUNTED
  // (bannerSlot provided AND not on the empty state), not merely a
  // candidate slot existing — a sidebar tip hides itself while the store
  // reports a visible banner. Count-based register/unregister keeps
  // concurrent instances (main chat + app-editing side panel) from
  // clobbering each other.
  const bannerSlot = <div data-testid="banner">BANNER_CONTENT</div>;
  const visible = () =>
    useBannerVisibilityStore.getState().visibleBannerCount > 0;

  beforeEach(() => {
    useBannerVisibilityStore.setState({ visibleBannerCount: 0 });
  });

  afterEach(() => {
    cleanup();
  });

  test("registers while the banner overlay is mounted, unregisters on unmount", () => {
    const { unmount } = render(<ChatBody {...baseProps({ bannerSlot })} />);
    expect(visible()).toBe(true);

    unmount();
    expect(visible()).toBe(false);
  });

  test("does NOT register on the empty state even when bannerSlot is provided", () => {
    render(<ChatBody {...withEmptyState({ bannerSlot })} />);
    expect(visible()).toBe(false);
  });

  test("does NOT register without a bannerSlot (side panel passes undefined)", () => {
    render(<ChatBody {...baseProps({ variant: "side-panel" })} />);
    expect(visible()).toBe(false);
  });

  test("empty→active transition flips the store as the banner mounts/unmounts", () => {
    const { rerender } = render(
      <ChatBody {...withEmptyState({ bannerSlot })} />,
    );
    expect(visible()).toBe(false);

    rerender(<ChatBody {...baseProps({ bannerSlot })} />);
    expect(visible()).toBe(true);

    rerender(<ChatBody {...withEmptyState({ bannerSlot })} />);
    expect(visible()).toBe(false);
  });

  test("a bannerless second instance does not clobber the first's visibility", () => {
    const main = render(<ChatBody {...baseProps({ bannerSlot })} />);
    const sidePanel = render(
      <ChatBody {...baseProps({ variant: "side-panel" })} />,
    );
    expect(visible()).toBe(true);

    sidePanel.unmount();
    expect(visible()).toBe(true);

    main.unmount();
    expect(visible()).toBe(false);
  });

  test("stays visible until every banner-rendering instance unmounts", () => {
    const first = render(<ChatBody {...baseProps({ bannerSlot })} />);
    const second = render(<ChatBody {...baseProps({ bannerSlot })} />);
    expect(useBannerVisibilityStore.getState().visibleBannerCount).toBe(2);

    first.unmount();
    expect(visible()).toBe(true);

    second.unmount();
    expect(visible()).toBe(false);
  });
});

describe("ChatBody — startersSlot rendering", () => {
  test("renders startersSlot content when provided", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...withEmptyState({
          startersSlot: <div data-testid="starters">STARTER_CHIPS</div>,
        })}
      />,
    );
    expect(html).toContain("STARTER_CHIPS");
  });

  test("omits starters when startersSlot is undefined", () => {
    const html = renderToStaticMarkup(<ChatBody {...withEmptyState()} />);
    expect(html).not.toContain("STARTER_CHIPS");
  });
});

describe("ChatBody - docked starters hide while the keyboard is open", () => {
  // The docked (mobile empty-state) suggestions row fades out and collapses
  // its reserved height while the soft keyboard is up, and the greeting +
  // composer group anchors to the bottom edge instead of centering. The dock
  // stays mounted so dismissing the keyboard restores it without a remount.
  // Class assertions here are regression pins on the markup, not proof of
  // the rendered layout.
  const startersSlot = <div data-testid="starters">STARTER_CHIPS</div>;

  const dockedProps = () =>
    withEmptyState({ dockStartersToBottom: true, startersSlot });

  const dockWrapper = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-slot="docked-starters"]');

  afterEach(() => {
    keyboardOpen = false;
    cleanup();
  });

  test("keyboard closed: the dock is expanded, interactive, unclipped, and the group centers", () => {
    keyboardOpen = false;
    const { container } = render(<ChatBody {...dockedProps()} />);

    const dock = dockWrapper(container);
    expect(dock).not.toBeNull();
    expect(dock?.className).not.toContain("opacity-0");
    expect(dock?.className).not.toContain("pointer-events-none");
    expect(dock?.hasAttribute("inert")).toBe(false);
    expect(dock?.style.gridTemplateRows).toBe("1fr");
    // Markup pin on the clip mechanism: at rest the inner div must not
    // clip, so keyboard-focus rings (painted outside the border box of the
    // cards and buttons inside) stay fully visible.
    expect(dock?.firstElementChild?.className).toContain("min-h-0");
    expect(dock?.firstElementChild?.className).not.toContain("overflow-hidden");
    expect(container.innerHTML).toContain("[justify-content:safe_center]");
    expect(container.innerHTML).not.toContain("justify-end");
  });

  test("keyboard open: the dock collapses, fades, goes inert, clips, and the group bottom-anchors", () => {
    keyboardOpen = true;
    const { container } = render(<ChatBody {...dockedProps()} />);

    const dock = dockWrapper(container);
    expect(dock).not.toBeNull();
    expect(container.innerHTML).toContain("STARTER_CHIPS");
    expect(dock?.className).toContain("opacity-0");
    expect(dock?.className).toContain("pointer-events-none");
    expect(dock?.hasAttribute("inert")).toBe(true);
    expect(dock?.style.gridTemplateRows).toBe("0fr");
    // Markup pin on the clip mechanism: the collapse animation clips the
    // shrinking row's content.
    expect(dock?.firstElementChild?.className).toContain("overflow-hidden");
    expect(container.innerHTML).toContain("justify-end");
    expect(container.innerHTML).not.toContain("[justify-content:safe_center]");
  });

  test("keyboard toggling flips the hidden treatment without unmounting", () => {
    keyboardOpen = true;
    const { container, rerender } = render(<ChatBody {...dockedProps()} />);
    expect(dockWrapper(container)?.className).toContain("opacity-0");
    expect(dockWrapper(container)?.style.gridTemplateRows).toBe("0fr");
    const mounted = container.querySelector('[data-testid="starters"]');
    expect(mounted).not.toBeNull();

    keyboardOpen = false;
    rerender(<ChatBody {...dockedProps()} />);
    expect(dockWrapper(container)?.className).not.toContain("opacity-0");
    expect(dockWrapper(container)?.style.gridTemplateRows).toBe("1fr");
    // Same DOM node across the toggle proves the dock never remounted.
    expect(container.querySelector('[data-testid="starters"]')).toBe(
      mounted as HTMLElement,
    );
  });
});

describe("ChatBody - plain empty state bottom-anchors while the keyboard is open", () => {
  // Before conversation starters arrive, the plain empty state renders the
  // NON-docked branch with no startersSlot (server-side starter generation
  // can take a while on a brand-new assistant). While the soft keyboard is
  // open that branch must bottom-anchor the greeting + composer group just
  // like the docked branch, so the composer docks to the keyboard edge in
  // the zero-starters window and the docked/non-docked flip when starters
  // arrive never moves the composer mid-typing. The app-editing side panel
  // is the one non-docked state WITH a startersSlot (its inline chips), and
  // it keeps its centered layout regardless of keyboard state.
  const startersSlot = <div data-testid="starters">STARTER_CHIPS</div>;

  afterEach(() => {
    keyboardOpen = false;
    cleanup();
  });

  test("keyboard open, zero starters: the group bottom-anchors instead of centering", () => {
    keyboardOpen = true;
    const { container } = render(<ChatBody {...withEmptyState()} />);

    expect(container.innerHTML).toContain("justify-end");
    expect(container.innerHTML).not.toContain("[justify-content:safe_center]");
  });

  test("starters arriving under an open keyboard keep the bottom anchor across the branch flip", () => {
    keyboardOpen = true;
    const { container, rerender } = render(<ChatBody {...withEmptyState()} />);
    expect(container.innerHTML).toContain("justify-end");
    expect(container.innerHTML).not.toContain("[justify-content:safe_center]");

    rerender(
      <ChatBody
        {...withEmptyState({ dockStartersToBottom: true, startersSlot })}
      />,
    );
    expect(container.innerHTML).toContain("justify-end");
    expect(container.innerHTML).not.toContain("[justify-content:safe_center]");
  });

  test("app-editing (non-docked with inline starters) stays centered with the keyboard open", () => {
    // Discriminates the gate: same non-docked empty state and open
    // keyboard, but with the inline startersSlot the app-editing branch
    // renders. A gate that bottom-anchored every non-docked empty state
    // would fail here by pushing the side panel's composer and chips to
    // the bottom edge.
    keyboardOpen = true;
    const { container } = render(
      <ChatBody {...withEmptyState({ variant: "side-panel", startersSlot })} />,
    );

    expect(container.innerHTML).toContain("STARTER_CHIPS");
    expect(container.innerHTML).toContain("[justify-content:safe_center]");
    expect(container.innerHTML).not.toContain("justify-end");
    expect(container.querySelector('[data-slot="docked-starters"]')).toBeNull();
  });
});

describe("ChatBody - the empty-state scroll container never carries alignment", () => {
  // Pins the scrollability STRUCTURE, not rendered geometry (happy-dom
  // performs no layout): with `justify-end` on the `overflow-y-auto`
  // container itself, content taller than the viewport overflows past the
  // START edge, which scrolling cannot reach, so the greeting becomes
  // unreachable on short viewports while the keyboard is open. The
  // conditional alignment must live on the inner `min-h-full` wrapper.

  const outerOf = (container: HTMLElement) =>
    container.firstElementChild as HTMLElement;

  afterEach(() => {
    keyboardOpen = false;
    cleanup();
  });

  test("keyboard open, zero starters: justify-end sits on the inner min-h-full wrapper, not the scroll container", () => {
    keyboardOpen = true;
    const { container } = render(<ChatBody {...withEmptyState()} />);

    const outer = outerOf(container);
    expect(outer.className).toContain("overflow-y-auto");
    expect(outer.className).not.toContain("justify-end");

    const inner = outer.firstElementChild as HTMLElement;
    expect(inner.className).toContain("min-h-full");
    expect(inner.className).toContain("justify-end");
  });

  test("at rest: safe_center sits on the inner min-h-full wrapper, not the scroll container", () => {
    keyboardOpen = false;
    const { container } = render(<ChatBody {...withEmptyState()} />);

    const outer = outerOf(container);
    expect(outer.className).toContain("overflow-y-auto");
    expect(outer.className).not.toContain("[justify-content:safe_center]");

    const inner = outer.firstElementChild as HTMLElement;
    expect(inner.className).toContain("min-h-full");
    expect(inner.className).toContain("[justify-content:safe_center]");
  });
});

describe("ChatBody - plugin pills hide while the keyboard is open", () => {
  // The plugin controls rendered below the composer share the dock's
  // collapse treatment (both call sites render through the same helper):
  // while the soft keyboard is up they fade out, collapse their reserved
  // height, and go inert so the composer, not the plugin row, docks to the
  // keyboard edge. The slot stays mounted so dismissing the keyboard
  // restores it without a remount.
  const pluginPillsSlot = <div data-testid="plugins">PLUGIN_PILLS</div>;

  const pluginProps = () =>
    withEmptyState({ dockStartersToBottom: true, pluginPillsSlot });

  const pluginsWrapper = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-slot="new-chat-plugins"]');

  afterEach(() => {
    keyboardOpen = false;
    cleanup();
  });

  test("keyboard open: the row collapses, fades, goes inert; closing restores it without a remount", () => {
    keyboardOpen = true;
    const { container, rerender } = render(<ChatBody {...pluginProps()} />);

    const wrapper = pluginsWrapper(container);
    expect(wrapper).not.toBeNull();
    expect(container.innerHTML).toContain("PLUGIN_PILLS");
    expect(wrapper?.className).toContain("opacity-0");
    expect(wrapper?.className).toContain("pointer-events-none");
    expect(wrapper?.hasAttribute("inert")).toBe(true);
    expect(wrapper?.style.gridTemplateRows).toBe("0fr");
    expect(wrapper?.firstElementChild?.className).toContain("overflow-hidden");
    const mounted = container.querySelector('[data-testid="plugins"]');
    expect(mounted).not.toBeNull();

    keyboardOpen = false;
    rerender(<ChatBody {...pluginProps()} />);
    const restored = pluginsWrapper(container);
    expect(restored?.className).not.toContain("opacity-0");
    expect(restored?.className).not.toContain("pointer-events-none");
    expect(restored?.hasAttribute("inert")).toBe(false);
    expect(restored?.style.gridTemplateRows).toBe("1fr");
    expect(restored?.firstElementChild?.className).not.toContain(
      "overflow-hidden",
    );
    // Same DOM node across the toggle proves the slot never remounted.
    expect(container.querySelector('[data-testid="plugins"]')).toBe(
      mounted as HTMLElement,
    );
  });
});

describe("ChatBody — pluginPillsSlot rendering", () => {
  test("renders pluginPillsSlot between the composer and the starters", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...withEmptyState({
          pluginPillsSlot: <div data-testid="plugins">PLUGIN_PILLS</div>,
          startersSlot: <div data-testid="starters">STARTER_CHIPS</div>,
        })}
      />,
    );
    expect(html).toContain("PLUGIN_PILLS");
    // Order: composer, then plugin pills, then starters.
    expect(html.indexOf("COMPOSER")).toBeLessThan(html.indexOf("PLUGIN_PILLS"));
    expect(html.indexOf("PLUGIN_PILLS")).toBeLessThan(
      html.indexOf("STARTER_CHIPS"),
    );
  });

  test("omits plugin pills when pluginPillsSlot is undefined", () => {
    const html = renderToStaticMarkup(<ChatBody {...withEmptyState()} />);
    expect(html).not.toContain("PLUGIN_PILLS");
  });
});

describe("ChatBody — active-process overlays slot", () => {
  // The orchestrator builds the registry-driven row (subagents → acp runs →
  // workflows → background tasks) and passes it as a single node; ChatBody
  // only positions it in the top-center overlay (and gates it on the empty
  // state). Ordering across kinds is owned by the registry, not ChatBody.
  const activeProcessOverlaysSlot = (
    <div data-testid="active-process-overlays">ACTIVE_PROCESSES</div>
  );

  test("renders the slot top-center when scrolled up and slot is provided", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          showScrollToLatest: true,
          activeProcessOverlaysSlot,
        })}
      />,
    );
    expect(html).toContain("ACTIVE_PROCESSES");
  });

  test("renders the slot even when pinned (showScrollToLatest false) — always-on while running", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          showScrollToLatest: false,
          activeProcessOverlaysSlot,
        })}
      />,
    );
    expect(html).toContain("ACTIVE_PROCESSES");
  });

  test("does NOT render the slot on the empty state", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...withEmptyState({
          showScrollToLatest: true,
          activeProcessOverlaysSlot,
        })}
      />,
    );
    expect(html).not.toContain("ACTIVE_PROCESSES");
  });

  test("does NOT render the overlay row when the slot is undefined", () => {
    const html = renderToStaticMarkup(
      <ChatBody {...baseProps({ showScrollToLatest: true })} />,
    );
    expect(html).not.toContain("ACTIVE_PROCESSES");
  });

  test("Go-to-Newest bottom overlay still renders alongside the slot (no regression)", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          showScrollToLatest: true,
          activeProcessOverlaysSlot,
        })}
      />,
    );
    expect(html).toContain("SCROLL_TO_LATEST");
    expect(html).toContain("ACTIVE_PROCESSES");
  });
});

describe("ChatBody — composer always renders", () => {
  // Channel-origin (Slack/Email/etc.) conversations render the standard
  // composer, with no read-only banner replacing it.
  test("renders the composer and no read-only banner", () => {
    const html = renderToStaticMarkup(<ChatBody {...baseProps()} />);

    expect(html).toContain("COMPOSER");
    expect(html).not.toContain("Read-only conversation");
  });
});

describe("ChatBody — channel footer slot", () => {
  test("renders channelFooterSlot immediately above the composer", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          channelFooterSlot: (
            <div data-testid="channel-footer">CHANNEL_FOOTER</div>
          ),
        })}
      />,
    );

    expect(html).toContain("CHANNEL_FOOTER");
    expect(html.indexOf("CHANNEL_FOOTER")).toBeLessThan(
      html.indexOf("COMPOSER"),
    );
  });
});

describe("ChatBody — generic chat error Notice (dismiss UX)", () => {
  // The Notice is rendered as an inline error banner above the composer.
  // The banner carries its own action ("Go to Doctor") plus the notice's
  // dismiss control, so the user has a real way to close the banner.

  test("renders the dismiss control when genericChatError + onDismissChatError are both provided", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          genericChatError: {
            message: "Model doesn't support image input.",
            actions: (
              <a href="/assistant/settings/debug?tab=doctor">Go to Doctor</a>
            ),
          },
          onDismissChatError: () => {},
        })}
      />,
    );

    expect(html).toContain("Go to Doctor");
    expect(html).toContain('data-testid="notice-dismiss"');
  });

  test("renders warning-tone generic notices as status banners", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          genericChatError: {
            message: "Memory is temporarily unavailable.",
            tone: "warning",
          },
          onDismissChatError: () => {},
        })}
      />,
    );

    expect(html).toContain("Memory is temporarily unavailable.");
    expect(html).toContain('data-tone="warning"');
  });

  test("does NOT render the dismiss control when onDismissChatError is omitted", () => {
    // Defensive: don't silently show a dismiss control that does nothing.
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          genericChatError: { message: "Something went wrong." },
        })}
      />,
    );

    expect(html).not.toContain("notice-dismiss");
  });

  test("does not render the error banner at all when genericChatError is null", () => {
    const html = renderToStaticMarkup(
      <ChatBody {...baseProps({ genericChatError: null })} />,
    );

    expect(html).not.toContain('data-testid="notice"');
  });
});

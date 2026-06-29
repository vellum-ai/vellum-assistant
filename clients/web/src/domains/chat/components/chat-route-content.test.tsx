/**
 * Focused test for the new-thread suggestion drawer wiring used by
 * `ChatMainPanel`.
 *
 * `ChatMainPanel` itself pulls in dozens of stores/hooks, so rather than
 * rendering the whole orchestrator we exercise the exact seam it composes: the
 * `useChatEmptyState` library slot drives `onSelectSuggestion`, which opens an
 * `AnimatedRightDrawer` holding a real `SuggestionDetailPanel`. All three are
 * the real components, so this asserts the actual behaviour:
 *
 * - clicking a featured card opens the drawer with that suggestion's detail;
 * - "Let's do it!" submits the suggestion's prompt and closes the drawer;
 * - close dismisses the drawer without submitting;
 * - on mobile the detail opens in a `BottomSheet` (not the desktop drawer) and
 *   still opens/confirms correctly.
 *
 * `motion/react` is mocked so the drawer mounts/unmounts synchronously instead
 * of depending on real animation timing (see active-subagents-overlay.test).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  createElement,
  useCallback,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import type { ThreadSuggestion } from "@/domains/chat/suggestions/types";

// --- Mocks ----------------------------------------------------------------

const flagRef = { value: true };

mock.module("@/stores/client-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    newThreadSuggestions: () => flagRef.value,
  };
  return { useClientFeatureFlagStore: store };
});

mock.module("@/domains/chat/hooks/use-empty-state-greeting", () => ({
  useEmptyStateGreeting: () => ({ greeting: "Hi there", isGenerating: false }),
}));

mock.module("@/domains/chat/hooks/use-conversation-starters", () => ({
  useConversationStarters: () => ({ starters: [] }),
}));

const FEATURED: ThreadSuggestion = {
  id: "sugg-1",
  title: "Email Helper",
  iconKey: "gmail",
  prompt: "Help me triage my inbox",
  detail: {
    heading: "Email Helper Detail",
    description: "Triage your inbox.",
    requirements: [],
    capabilities: ["Summarize threads"],
  },
};

mock.module("@/domains/chat/hooks/use-thread-suggestions", () => ({
  useThreadSuggestions: () => ({ featured: [FEATURED], groups: [] }),
}));

// Render motion elements synchronously and fire `onAnimationComplete` after
// each render so the drawer mounts on open and its close path (which unmounts
// content onAnimationComplete) resolves without real animation timing.
const MOTION_ONLY_PROPS = new Set([
  "initial",
  "animate",
  "exit",
  "transition",
  "variants",
  "whileHover",
  "whileTap",
  "layout",
  "layoutId",
  "custom",
  "onAnimationStart",
  "onAnimationComplete",
]);

function MotionStub({
  tag,
  onAnimationComplete,
  ...rest
}: Record<string, unknown> & {
  tag: string;
  onAnimationComplete?: () => void;
}) {
  useEffect(() => {
    onAnimationComplete?.();
  });
  return createElement(tag, rest);
}

mock.module("motion/react", () => ({
  motion: new Proxy(
    {} as Record<string, (props: Record<string, unknown>) => ReactElement>,
    {
      get: (_target, tag) => (props: Record<string, unknown>) => {
        const domProps: Record<string, unknown> = {};
        for (const key in props) {
          if (!MOTION_ONLY_PROPS.has(key)) domProps[key] = props[key];
        }
        return createElement(MotionStub, {
          ...domProps,
          tag: String(tag),
          onAnimationComplete: props.onAnimationComplete as
            | (() => void)
            | undefined,
        });
      },
    },
  ),
  AnimatePresence: ({ children }: { children?: ReactNode }) => children,
  useReducedMotion: () => true,
}));

import { BottomSheet } from "@vellumai/design-library";

import { AnimatedRightDrawer } from "@/domains/chat/components/animated-right-drawer";
import { SuggestionDetailPanel } from "@/domains/chat/components/suggestion-detail-panel";
import { useComposerStore } from "@/domains/chat/composer-store";
import { useChatEmptyState } from "@/domains/chat/hooks/use-chat-empty-state";

// Harness mirroring ChatMainPanel's drawer wiring with the real components.
// `isMobile` selects the same desktop-drawer vs mobile-sheet branch the
// production component picks via `useIsMobile()`.
function Harness({
  onSubmit,
  isMobile = false,
  conversationId = "c1",
  isEmptyConversation = true,
}: {
  onSubmit: (prompt: string) => void;
  isMobile?: boolean;
  conversationId?: string;
  isEmptyConversation?: boolean;
}) {
  const [selected, setSelected] = useState<ThreadSuggestion | null>(null);

  // Mirror ChatMainPanel's reset effect: clear any open detail when the active
  // conversation changes or the thread leaves the empty state.
  useEffect(() => {
    setSelected(null);
  }, [conversationId, isEmptyConversation]);

  const { startersSlot } = useChatEmptyState({
    assistantId: "a1",
    conversationId,
    isEmptyConversation,
    avatar: { components: null, traits: null, customImageUrl: null } as never,
    mainView: "chat",
    openedAppState: null,
    isAssistantStreaming: false,
    activeConversationIsProcessing: false,
    onSelectStarter: () => {},
    onSelectSuggestion: setSelected,
  });

  const handleClose = useCallback(() => setSelected(null), []);
  const handleConfirm = useCallback(
    (s: ThreadSuggestion) => {
      // Mirror the production wiring: seed the composer before submitting so a
      // blocked send leaves the prompt available to retry.
      useComposerStore.getState().setInput(s.prompt);
      setSelected(null);
      onSubmit(s.prompt);
    },
    [onSubmit],
  );
  const detailPanel = selected ? (
    <SuggestionDetailPanel
      suggestion={selected}
      onClose={handleClose}
      onConfirm={handleConfirm}
    />
  ) : null;

  if (isMobile) {
    return (
      <>
        <div>{startersSlot}</div>
        <BottomSheet.Root
          open={Boolean(selected)}
          onOpenChange={(next) => {
            if (!next) handleClose();
          }}
        >
          <BottomSheet.Content aria-describedby={undefined}>
            <BottomSheet.Header className="sr-only">
              <BottomSheet.Title>
                {selected?.detail.heading ?? "Suggestion"}
              </BottomSheet.Title>
            </BottomSheet.Header>
            {detailPanel}
          </BottomSheet.Content>
        </BottomSheet.Root>
      </>
    );
  }

  return (
    <AnimatedRightDrawer
      open={Boolean(selected)}
      left={<div>{startersSlot}</div>}
      right={detailPanel}
    />
  );
}

beforeEach(() => {
  flagRef.value = true;
});

afterEach(() => {
  cleanup();
});

describe("ChatMainPanel suggestion drawer wiring", () => {
  test("clicking a featured card opens the drawer with its detail", () => {
    const submitted: string[] = [];
    const { getByText, container } = render(
      <Harness onSubmit={(p) => submitted.push(p)} />,
    );

    expect(
      container.querySelector('[data-slot="suggestion-detail-panel"]'),
    ).toBeNull();

    fireEvent.click(getByText(FEATURED.title));

    expect(
      container.querySelector('[data-slot="suggestion-detail-panel"]'),
    ).not.toBeNull();
    expect(getByText(FEATURED.detail.heading)).toBeTruthy();
    expect(submitted).toHaveLength(0);
  });

  test("'Let's do it!' submits the prompt and closes the drawer", () => {
    const submitted: string[] = [];
    const { getByText, container } = render(
      <Harness onSubmit={(p) => submitted.push(p)} />,
    );

    fireEvent.click(getByText(FEATURED.title));
    fireEvent.click(getByText("Let's do it!"));

    expect(submitted).toEqual([FEATURED.prompt]);
    // The prompt is seeded into the composer so a blocked send is recoverable.
    expect(useComposerStore.getState().input).toBe(FEATURED.prompt);
    expect(
      container.querySelector('[data-slot="suggestion-detail-panel"]'),
    ).toBeNull();
  });

  test("close dismisses the drawer without submitting", () => {
    const submitted: string[] = [];
    const { getByText, getByLabelText, container } = render(
      <Harness onSubmit={(p) => submitted.push(p)} />,
    );

    fireEvent.click(getByText(FEATURED.title));
    fireEvent.click(getByLabelText("Close"));

    expect(submitted).toHaveLength(0);
    expect(
      container.querySelector('[data-slot="suggestion-detail-panel"]'),
    ).toBeNull();
  });

  test("switching to another empty thread clears the open detail", () => {
    const submitted: string[] = [];
    const { getByText, container, rerender } = render(
      <Harness conversationId="c1" onSubmit={(p) => submitted.push(p)} />,
    );

    fireEvent.click(getByText(FEATURED.title));
    expect(
      container.querySelector('[data-slot="suggestion-detail-panel"]'),
    ).not.toBeNull();

    // New empty thread: id changes while `isEmptyConversation` stays true. The
    // reset effect must still close the stale drawer so nothing leaks into the
    // newly active thread.
    rerender(
      <Harness conversationId="c2" onSubmit={(p) => submitted.push(p)} />,
    );

    expect(
      container.querySelector('[data-slot="suggestion-detail-panel"]'),
    ).toBeNull();
    expect(submitted).toHaveLength(0);
  });

  test("mobile: card click opens the detail in a bottom sheet and confirms", () => {
    const submitted: string[] = [];
    // The sheet portals outside `container`, so query the whole document
    // (`baseElement`, default document.body) instead.
    const { getByText, baseElement } = render(
      <Harness isMobile onSubmit={(p) => submitted.push(p)} />,
    );

    // Closed: no detail panel and no desktop split.
    expect(
      baseElement.querySelector('[data-slot="suggestion-detail-panel"]'),
    ).toBeNull();
    expect(
      baseElement.querySelector('[data-slot="animated-right-drawer"]'),
    ).toBeNull();

    fireEvent.click(getByText(FEATURED.title));

    // Opens in the bottom sheet (still no desktop drawer). The panel's heading
    // lives inside its own `data-slot`; an sr-only Dialog.Title duplicates the
    // text for accessibility, so scope the heading assertion to the panel.
    const sheet = baseElement.querySelector(
      '[data-slot="bottom-sheet-content"]',
    );
    expect(sheet).not.toBeNull();
    expect(
      baseElement.querySelector('[data-slot="animated-right-drawer"]'),
    ).toBeNull();
    expect(
      sheet?.querySelector('[data-slot="suggestion-detail-panel"]'),
    ).not.toBeNull();
    expect(submitted).toHaveLength(0);

    fireEvent.click(getByText("Let's do it!"));

    expect(submitted).toEqual([FEATURED.prompt]);
    expect(useComposerStore.getState().input).toBe(FEATURED.prompt);
    expect(
      baseElement.querySelector('[data-slot="suggestion-detail-panel"]'),
    ).toBeNull();
  });
});

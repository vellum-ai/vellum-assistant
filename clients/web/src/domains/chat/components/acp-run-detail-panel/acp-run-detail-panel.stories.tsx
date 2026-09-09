import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState, type ReactNode } from "react";
import { screen, userEvent } from "storybook/test";

import { TOUCH_SURFACE_MEDIA_QUERY } from "@vellumai/design-library/utils/touch-surface";

import type { AcpModelOption, AcpRunEntry } from "@/domains/chat/acp-run-store";
import { MIN_VERSION } from "@/lib/backwards-compat/acp-model-switching";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

import { DetailPanelStoryFrame } from "@/domains/chat/components/detail-panel-story-frame";

import { AcpRunDetailPanel } from "./acp-run-detail-panel";

const ASSISTANT_ID = "story-assistant";

const meta: Meta<typeof AcpRunDetailPanel> = {
  title: "Chat/AcpRunDetailPanel",
  component: AcpRunDetailPanel,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <DetailPanelStoryFrame>
        <Story />
      </DetailPanelStoryFrame>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AcpRunDetailPanel>;

const runningEntry: AcpRunEntry = {
  acpSessionId: "acp-ibm",
  agent: "claude",
  parentConversationId: "conv-1",
  task: "Review IBM's Q2 2026 results and five-year prospects, then give a focused strategic recommendation.",
  status: "running",
  startedAt: Date.now() - 61_500,
  usedTokens: 61_500,
  contextSize: 200_000,
  inputTokens: 61_500,
  outputTokens: 1_700,
  events: [],
};

const completedEntry: AcpRunEntry = {
  ...runningEntry,
  acpSessionId: "acp-ibm-done",
  status: "completed",
  completedAt: Date.now(),
};

export const Running: Story = {
  args: {
    entry: runningEntry,
    onClose: () => {},
  },
};

export const Completed: Story = {
  args: {
    entry: completedEntry,
    onClose: () => {},
  },
};

// ---------------------------------------------------------------------------
// Runs that report a model
// ---------------------------------------------------------------------------

/**
 * The options an ACP adapter reports: an ungrouped row followed by two named
 * groups, which is the shape the menu has to draw headings for.
 */
const MODEL_OPTIONS: AcpModelOption[] = [
  {
    value: "default",
    label: "Default",
    description: "Whatever the agent picks",
  },
  {
    value: "sonnet",
    label: "Sonnet",
    description: "Fast, for most turns",
    group: "Claude",
  },
  {
    value: "opus",
    label: "Opus",
    description: "Most capable",
    group: "Claude",
  },
  { value: "haiku", label: "Haiku", description: "Fastest", group: "Claude" },
  { value: "fable", label: "Fable", group: "Claude" },
  {
    value: "opusplan",
    label: "Opus plan mode",
    description: "Opus to plan, Sonnet to execute",
    group: "Mixed",
  },
];

const runningWithModelEntry: AcpRunEntry = {
  ...runningEntry,
  acpSessionId: "acp-ibm-model",
  model: "opus",
  availableModels: MODEL_OPTIONS,
};

// A terminal run keeps the model it ran on and loses the selector, so the tile
// shows the adapter's raw value with nothing to look a label up in.
const completedWithModelEntry: AcpRunEntry = {
  ...completedEntry,
  acpSessionId: "acp-ibm-model-done",
  model: "opus",
};

/**
 * Pins the version the ACP model-switching gate reads, then puts it back.
 *
 * The identity store is a module singleton, so a story that leaves a version
 * behind changes how later stories resolve. Seeding in `beforeEach` rather
 * than during decorator render also keeps the write out of the render pass,
 * where two mounted variants would race and the last one would win. The gate
 * is scoped, so the owner has to be stamped alongside the version or the
 * MODEL tile stays hidden.
 */
function seedAssistantVersion() {
  const { version, assistantId } = useAssistantIdentityStore.getState();
  useAssistantIdentityStore.setState({
    version: MIN_VERSION,
    assistantId: ASSISTANT_ID,
  });
  return () => {
    useAssistantIdentityStore.setState({ version, assistantId });
  };
}

/** Swap `window.matchMedia`; `configurable` so the teardown can put it back. */
function setMatchMedia(impl: typeof window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    value: impl,
    configurable: true,
    writable: true,
  });
}

/**
 * Answers the design library's touch-surface query `true` for the duration of
 * the story, so `ActionMenu` resolves to its bottom sheet.
 *
 * The mobile viewport alone cannot do it: the query is a narrow viewport AND a
 * coarse pointer, and a desktop browser at phone width still reports a fine
 * one. The tile takes no presentation prop by design, so the signal itself is
 * what a story has to move.
 */
function ForceTouchSurface({ children }: { children: ReactNode }) {
  // Installed from a `useState` initializer, which runs exactly once and during
  // this component's render, i.e. before any child samples the query. An
  // identity check against the saved original would not work here: `bind`
  // returns a new function object, so it never compares equal to the global.
  const [original] = useState(() => {
    const saved = window.matchMedia.bind(window);
    setMatchMedia(((query: string) => {
      const result = saved(query);
      if (query !== TOUCH_SURFACE_MEDIA_QUERY) {
        return result;
      }
      return {
        ...result,
        media: query,
        matches: true,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      } as MediaQueryList;
    }) as typeof window.matchMedia);
    return saved;
  });
  useEffect(() => {
    return () => setMatchMedia(original);
  }, [original]);
  return <>{children}</>;
}

/**
 * A live run whose adapter offers a model list. The MODEL tile takes a row of
 * its own under the token pair: a model id in half of a 400px panel has
 * nowhere to render.
 */
export const RunningWithModel: Story = {
  beforeEach: seedAssistantVersion,
  args: {
    entry: runningWithModelEntry,
    onClose: () => {},
    assistantId: ASSISTANT_ID,
  },
};

/**
 * A finished run. There is nothing left to switch, so the tile is the plain
 * metric card carrying the value the adapter last reported.
 */
export const CompletedWithModel: Story = {
  beforeEach: seedAssistantVersion,
  args: {
    entry: completedWithModelEntry,
    onClose: () => {},
    assistantId: ASSISTANT_ID,
  },
};

/**
 * The same picker under a thumb. `ActionMenu` substitutes a bottom sheet for
 * the anchored menu, so the rows become sheet rows with a visible title and
 * the surface is a dialog rather than a menu.
 */
export const MobileSheet: Story = {
  beforeEach: seedAssistantVersion,
  args: {
    entry: runningWithModelEntry,
    onClose: () => {},
    assistantId: ASSISTANT_ID,
  },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
  decorators: [
    (Story) => (
      <ForceTouchSurface>
        <Story />
      </ForceTouchSurface>
    ),
  ],
  play: async () => {
    await userEvent.click(
      await screen.findByRole("button", { name: /Change model/ }),
    );
    await screen.findByRole("dialog");
  },
};

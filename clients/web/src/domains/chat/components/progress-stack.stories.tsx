/**
 * The status cluster as a whole: Progress and Agents together.
 *
 * The individual triggers have their own stories; this file exists for what
 * only shows up when the two sit side by side: that their heights agree, that
 * they align on one edge, and that the loading sweep runs across both in step
 * rather than each starting its own cycle.
 *
 * Both arrangements are covered. The harness mounts BOTH `ProgressStack`
 * instances the app does (the floating one and the composer-row one) inside a
 * real `SideControlPlacementBoundary`, so the stories exercise the actual
 * measurement rather than a mocked flag, and show which mount wins at a given
 * column width. Exactly one draws.
 *
 */

import { useEffect, useState, type CSSProperties } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { randomCharacterTraits } from "@/utils/avatar-random";
import { ProgressStack } from "@/domains/chat/components/progress-stack";
import { SideControlPlacementBoundary } from "@/domains/chat/components/side-control-placement";
import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const ASSISTANT_ID = "asst-story";
const CONVERSATION_ID = "conv-story";
const T0 = 1_700_000_000_000;

function seedPlan(status: string): void {
  useChatSessionStore.setState({
    snapshot: {
      messages: [
        {
          id: "m-plan",
          role: "assistant",
          timestamp: T0,
          surfaces: [
            {
              surfaceId: "sfc-plan",
              type: "card",
              data: {
                template: "task_progress",
                templateData: {
                  title: "Building your toggle",
                  status,
                  steps: [
                    {
                      label: "Scope the request",
                      status: "completed",
                      detail: "Confirmed target + constraints",
                    },
                    {
                      label: "Pull the data",
                      status: "completed",
                      detail: "3 sources fetched",
                    },
                    {
                      label: "Build the artifact",
                      status:
                        status === "completed" ? "completed" : "in_progress",
                    },
                    {
                      label: "Hand over",
                      status: status === "completed" ? "completed" : undefined,
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
    },
    optimisticSends: [],
    dismissedSurfaceIds: new Set<string>(),
  } as never);
}

function seedAgents(running: boolean): void {
  if (running) {
    useAcpRunStore.getState().spawnRun({
      acpSessionId: "acp-live",
      agent: "claude",
      parentConversationId: CONVERSATION_ID,
      startedAt: T0,
    });
    useAcpRunStore.getState().receiveEvent({
      acpSessionId: "acp-live",
      event: {
        seq: 1,
        updateType: "tool_call",
        toolCallId: "tc-1",
        toolTitle: "Reading gateway restart logs",
        toolStatus: "in_progress",
      },
    });
  }
  for (const [i, label] of ["test-agent-1", "test-agent-2"].entries()) {
    const id = `sa-${i}`;
    useSubagentStore.getState().spawnSubagent({
      subagentId: id,
      label,
      objective: label,
      status: running ? "running" : "completed",
      conversationId: `${id}-child`,
      parentConversationId: CONVERSATION_ID,
      timestamp: T0 + i * 100,
    });
    // Without a loaded timeline a finished subagent projects as `loading`,
    // which would put the wrong card behind the trigger.
    useSubagentStore.getState().loadDetail({
      subagentId: id,
      events: [
        { id: `${id}-e1`, type: "text", content: "Done", timestamp: T0 },
      ],
    });
  }
}

/**
 * A random character avatar for the story, so the entrance actually plays its
 * takeover: the wash needs an accent color and the eyes need an eye style, and
 * an unseeded assistant has neither.
 *
 * Random rather than fixed on purpose: the treatment has to hold up across the
 * whole palette, not just one flattering hue, and rerunning the story is the
 * cheapest way to see that. `--avatar-accent` is set on the element because
 * that is the property the wash reads; the app publishes it from
 * `useAvatarAccentVar`, which no story mounts.
 */
function seedAvatar(queryClient: QueryClient): string | null {
  const traits = randomCharacterTraits(BUNDLED_COMPONENTS);
  queryClient.setQueryData(avatarQueryKey(ASSISTANT_ID), {
    components: BUNDLED_COMPONENTS,
    traits,
    customImageUrl: null,
  });
  return (
    BUNDLED_COMPONENTS.colors.find((c) => c.id === traits.color)?.hex ?? null
  );
}

/**
 * The custom-image case: a real avatar, but no character parts. The control
 * should slide in with no wash and no eyes.
 */
function seedCustomAvatar(queryClient: QueryClient): void {
  queryClient.setQueryData(avatarQueryKey(ASSISTANT_ID), {
    components: BUNDLED_COMPONENTS,
    traits: randomCharacterTraits(BUNDLED_COMPONENTS),
    customImageUrl: "https://example.invalid/avatar.png",
  });
}

function reset(): void {
  useAcpRunStore.getState().reset();
  useSubagentStore.getState().reset();
  useChatSessionStore.setState({
    snapshot: { messages: [] },
    optimisticSends: [],
    dismissedSurfaceIds: new Set<string>(),
  } as never);
}

function Harness({
  loading,
  columnWidth = 1120,
  customAvatar = false,
}: {
  loading: boolean;
  /** Seeds a custom image instead of a character, dropping the takeover. */
  customAvatar?: boolean;
  /**
   * Width of the stand-in chat column. The boundary measures it to decide
   * whether the controls can float, so it is the knob that exercises the
   * fallback: a centred 800px transcript needs 140px of gutter either side, so
   * 1120 floats and anything near 800 falls back to the composer row.
   */
  columnWidth?: number;
}) {
  const queryClient = useQueryClient();
  const [accent, setAccent] = useState<string | null>(null);
  const [seeded] = useState(() => {
    reset();
    if (customAvatar) {
      seedCustomAvatar(queryClient);
    } else {
      setAccent(seedAvatar(queryClient));
    }
    useResolvedAssistantsStore.setState({
      activeAssistantId: ASSISTANT_ID,
    } as never);
    useConversationStore.setState({
      activeConversationId: CONVERSATION_ID,
    } as never);
    seedPlan(loading ? "in_progress" : "completed");
    seedAgents(loading);
    return true;
  });
  void seeded;

  useEffect(() => reset, []);

  // Stands in for the chat column, laid out the way the app lays it out: the
  // floating mount at the top, the transcript, then the composer with the
  // fallback row directly above it. The grey blocks are the thread and the
  // input, there to show that neither arrangement overlaps them.
  return (
    <div
      style={
        {
          width: columnWidth,
          ...(accent ? { "--avatar-accent": accent } : {}),
        } as CSSProperties
      }
    >
      <SideControlPlacementBoundary className="relative flex h-[360px] flex-col overflow-hidden rounded-lg bg-[var(--surface-base)]">
        <ProgressStack placement="column" />
        <div className="mx-auto mt-3 w-full max-w-[800px] flex-1 px-4">
          <div className="h-24 rounded-lg bg-[var(--surface-lift)]" />
        </div>
        <div className="mx-auto w-full max-w-[800px] px-4 pb-3">
          <ProgressStack placement="composer" />
          <div className="h-12 rounded-xl bg-[var(--surface-lift)]" />
        </div>
      </SideControlPlacementBoundary>
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: "Chat/ProgressStack",
  component: Harness,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof Harness>;

/**
 * A wide column: the cluster floats in the right gutter, clear of both the
 * thread and the input.
 *
 * At rest only Assets and Progress are present. Assets is always there, and
 * Progress is holding a finished, unacknowledged plan. Agents has left, because
 * nothing is working. That asymmetry is the design, not a gap.
 */
export const FloatingIdle: Story = {
  args: { loading: false },
};

/**
 * **Loading, floating.** A plan in progress and agents still working: both
 * pills sweep, phase-locked, so the glints travel together instead of each
 * running its own cycle.
 */
export const FloatingLoading: Story = {
  args: { loading: true },
};

/**
 * A column too narrow to hold a gutter, which is what a document viewer opening beside
 * the chat looks like. The floating mount stands down and the controls reappear
 * in the composer's settings row, the one strip that is free at any width. They
 * enter from the BOTTOM there rather than the right, following the edge they
 * are anchored to.
 */
export const OverflowToComposer: Story = {
  args: { loading: false, columnWidth: 820 },
};

/** The fallback arrangement mid-sweep. */
export const OverflowToComposerLoading: Story = {
  args: { loading: true, columnWidth: 820 },
};

/**
 * An assistant with a custom uploaded image. The controls still slide in, but
 * the avatar takeover is skipped entirely: a custom image has no accent hue to
 * wash with and no eye sprite to surface, so the gesture has nothing to play.
 */
export const CustomAvatarNoTakeover: Story = {
  args: { loading: true, customAvatar: true },
};

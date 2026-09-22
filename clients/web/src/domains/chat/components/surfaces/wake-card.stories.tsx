import type { Meta, StoryObj } from "@storybook/react-vite";

import type { Surface } from "@/domains/chat/types/types";

import { TranscriptColumn } from "@/domains/chat/transcript/transcript-column";
import { WakeDetailPanel } from "@/domains/chat/components/wake-detail-panel";
import { useViewerStore } from "@/stores/viewer-store";

import { SurfaceRouter } from "./surface-router";

/**
 * The card the daemon posts when something wakes a conversation, and the panel
 * behind its "View details".
 *
 * The card is titled by what woke the conversation, derived from the wake's
 * source: the daemon titles every one of these "Conversation Woke", which
 * names the mechanism rather than answering the question the card exists to
 * answer. Under it sits a one-line recap, because the payload behind it is a
 * machine-written report: a workflow's run id, token counts, and JSON result
 * tail. That belongs in the panel, and so does the raw source value.
 *
 * Borderless on purpose. A wake card is the conversation explaining why it
 * started talking, so it reads as part of the transcript rather than as
 * something handed to it.
 */
const meta: Meta = {
  title: "Chat/Surfaces/WakeCard",
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <TranscriptColumn>
        <Story />
      </TranscriptColumn>
    ),
  ],
};

export default meta;
type Story = StoryObj;

/** The daemon's workflow completion summary, verbatim in shape. */
const WORKFLOW_HINT = [
  '[workflow "Classify observed subscriber use cases" completed]',
  "Run 387bfa70-4ba4-47be-b223-10922bf740cc finished with status: completed.",
  "Agents spawned: 1. Tokens: 608 in / 213 out.",
  'Result: [{"confidence":"low","email":"stub","evidence_note":"No useable ' +
    "evidence was provided. The email and prompts are placeholders " +
    '("stub"), and tasks/tools arrays are empty. Onboarding selections and ' +
    "setup chatter are absent, so no concrete usage can be observed. All " +
    'slots marked insufficient per instructions.","evidence_status":' +
    '"insufficient","use_case_1":"Insufficient observed usage","use_case_2":' +
    '"Insufficient observed usage","use_case_3":"Insufficient observed ' +
    'usage"}]',
].join("\n");

function wakeSurface(body: string, source: string): Surface {
  return {
    // Both daemon emitters build the id this way, and it is what marks a card
    // as a wake announcement to the client.
    surfaceId: "wake-conv-42-1757000000000",
    surfaceType: "card",
    title: "Conversation Woke",
    data: {
      title: "Conversation Woke",
      body,
      metadata: [{ label: "Source", value: source }],
    },
  };
}

/**
 * What lands in the transcript: title, recap, and the way into the rest. The
 * source is deliberately absent here.
 */
export const Card: Story = {
  render: () => (
    <SurfaceRouter
      surface={wakeSurface(WORKFLOW_HINT, "workflow_completed")}
      onAction={() => {}}
    />
  ),
};

/**
 * A scheduled wake whose hint arrived as one unbroken paragraph: a different
 * title, and a recap taken from the first sentence rather than a tag line.
 */
export const ScheduledRun: Story = {
  render: () => (
    <SurfaceRouter
      surface={wakeSurface(
        "The nightly inbox sweep finished. It archived 42 newsletters, " +
          "unsubscribed from 3 senders, and left everything else where it " +
          "was because no rule matched.",
        "schedule",
      )}
      onAction={() => {}}
    />
  ),
};

/** A source with no entry in the title map, which still reads as true. */
export const UnknownSource: Story = {
  render: () => (
    <SurfaceRouter
      surface={wakeSurface(
        "Something the client has never heard of finished.",
        "brand-new-trigger",
      )}
      onAction={() => {}}
    />
  ),
};

/**
 * The panel "View details" opens: the full hint as sent, then the source the
 * card no longer shows. Rendered at a drawer's width and height, which is the
 * only thing the chat layout adds around it.
 */
export const DetailPanel: Story = {
  render: () => (
    <div className="h-[560px] w-[420px]">
      <WakeDetailPanel
        payload={{
          title: "Workflow finished",
          body: WORKFLOW_HINT,
          metadata: [{ label: "Source", value: "workflow_completed" }],
        }}
        onClose={() => {}}
      />
    </div>
  ),
};

/**
 * The two together, wired the way the app wires them: pressing "View details"
 * puts the payload in `viewer-store`, and the panel draws whatever is there.
 */
export const CardOpensPanel: Story = {
  render: function CardOpensPanelStory() {
    const activeWakeDetail = useViewerStore.use.activeWakeDetail();
    const closeWakeDetail = useViewerStore.use.closeWakeDetail();

    return (
      <div className="flex items-start gap-6">
        <div className="min-w-0 flex-1">
          <SurfaceRouter
            surface={wakeSurface(WORKFLOW_HINT, "workflow_completed")}
            onAction={() => {}}
          />
        </div>
        {activeWakeDetail && (
          <div className="h-[560px] w-[420px] shrink-0">
            <WakeDetailPanel
              payload={activeWakeDetail}
              onClose={closeWakeDetail}
            />
          </div>
        )}
      </div>
    );
  },
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

import { ResizablePanel } from "@vellumai/design-library";

import type { Surface } from "@/domains/chat/types/types";
import type { QuestionEntry } from "@/types/interaction-ui-types";

import {
  PERSONA_PORTER,
  portPromptBlockSurface,
  specificsCardSurface,
} from "@/domains/chat/components/surfaces/activation-personas";
import {
  QuestionPromptDemo,
  StaticSurface,
} from "@/domains/chat/components/surfaces/activation-story-helpers";
import { MemoryGraphView } from "@/domains/intelligence/components/knowledge-web/memory-graph-view";
import {
  PERSONA_MEMORY_GRAPHS,
  conceptPageRevealedSlugs,
  conceptPagesToGraph,
} from "@/domains/intelligence/components/knowledge-web/memory-graph-data";

/**
 * Full activation rail — the demoable end-to-end (JARVIS-1112). Lives at the
 * top level (not under a domain) because it composes BOTH the chat conversation
 * surfaces and the intelligence memory web; cross-domain composition belongs at
 * the page level.
 *
 * Step the moments and watch two things move together: the conversation builds
 * up on the left (real surfaces + the assistant's ask-a-question UI), and the
 * assistant's model of you fills in on the right. Note Propose grows the
 * conversation but writes NO memory — it's output, not learning.
 */
const meta: Meta = {
  title: "ActivationFlow/FullRail",
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-[1240px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj;

type Moment = 0 | 1 | 2 | 3 | 4;

const MOMENT_LABEL: Record<Moment, string> = {
  0: "Hatched",
  1: "Port",
  2: "Propose",
  3: "Run",
  4: "Follow-through",
};

const proposeQuestion: QuestionEntry = {
  id: "propose-outcome",
  question: "Want me to start by cleaning up your inbox?",
  description:
    "You mentioned investor threads getting buried — I'll surface them and protect anything from Maya.",
  options: [
    {
      id: "inbox",
      label: "Yes — clean up my inbox",
      description: "Archive the noise, protect Maya, surface the replies you owe.",
    },
    {
      id: "calendar",
      label: "Protect my calendar first",
      description: "Block focus time for the raise instead.",
    },
  ],
  freeTextPlaceholder: "Tell me what to start with",
};

const followThroughQuestion: QuestionEntry = {
  id: "follow-through",
  question: "Want me to keep on top of this every morning?",
  description:
    "A weekday 7:30 AM brief would flag investor threads and the replies you owe.",
  options: [
    {
      id: "brief",
      label: "Set up a morning brief",
      description:
        "Weekdays at 7:30 AM — and I'll get sharper at the angle you actually act on.",
    },
    {
      id: "draft",
      label: "Just draft the two replies for now",
      description: "I'll prep them for your review, nothing sent.",
    },
  ],
  freeTextPlaceholder: "Something else",
};

const inboxResultSurface: Surface = {
  surfaceId: "rail-work-result",
  surfaceType: "work_result",
  title: "Inbox cleaned up",
  data: {
    status: "completed",
    summary:
      "Archived newsletters and receipts, kept everything from Maya, and surfaced the investor threads that need a reply.",
    metrics: [
      { label: "Archived", value: 31, tone: "positive" },
      { label: "Protected", value: "Maya", tone: "neutral" },
      { label: "Needs reply", value: 2, tone: "warning" },
    ],
    sections: [
      {
        id: "attention",
        title: "Needs a reply",
        type: "items",
        items: [
          {
            id: "tcg",
            title: "TCG reimbursement",
            description: "Open ref 49747972 — chase it.",
            status: "Reply today",
            tone: "warning",
          },
          {
            id: "investor",
            title: "Investor thread",
            description: "Buried under newsletters; surfaced to the top.",
            status: "Reply today",
            tone: "warning",
          },
        ],
      },
    ],
  },
};

function HatchedGreeting() {
  return (
    <div className="max-w-[80%] rounded-lg bg-[var(--surface-lift)] px-4 py-3 text-body-medium-default text-[var(--content-default)]">
      Hey — I’m brand new here. Want to bring context from another assistant, or
      just answer a couple of questions to get me useful?
    </div>
  );
}

function MomentLabel({ moment }: { moment: Moment }) {
  return (
    <div className="mt-2 text-label-small-default uppercase tracking-wide text-[var(--content-tertiary)]">
      {MOMENT_LABEL[moment]}
    </div>
  );
}

function RailDemo() {
  const [moment, setMoment] = useState<Moment>(0);
  const graph = PERSONA_MEMORY_GRAPHS.porter!;
  const data = useMemo(() => conceptPagesToGraph(graph), [graph]);
  const revealed = useMemo(
    () => conceptPageRevealedSlugs(graph, moment),
    [graph, moment],
  );

  // Conversation content per moment, rendered cumulatively up to the current one.
  const steps: { moment: Moment; node: React.ReactNode }[] = [
    { moment: 0, node: <HatchedGreeting /> },
    {
      moment: 1,
      node: (
        <div className="flex flex-col gap-3">
          <StaticSurface surface={portPromptBlockSurface(PERSONA_PORTER)} />
          <StaticSurface surface={specificsCardSurface(PERSONA_PORTER, 3)} />
        </div>
      ),
    },
    { moment: 2, node: <QuestionPromptDemo entry={proposeQuestion} /> },
    { moment: 3, node: <StaticSurface surface={inboxResultSurface} /> },
    { moment: 4, node: <QuestionPromptDemo entry={followThroughQuestion} /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Stepper. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-label-small-default uppercase tracking-wide text-[var(--content-tertiary)]">
          Moment
        </span>
        {([0, 1, 2, 3, 4] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMoment(m)}
            className={[
              "rounded-md px-3 py-1 text-body-small-default transition-colors",
              moment === m
                ? "bg-[var(--primary-base)] text-[var(--content-inset)]"
                : "border border-[var(--border-element)] bg-[var(--surface-base)] text-[var(--content-secondary)] hover:bg-[var(--surface-hover)]",
            ].join(" ")}
          >
            {MOMENT_LABEL[m]}
          </button>
        ))}
      </div>

      {/* Split screen — exactly how it looks in the app: conversation on the
          left, the memory web as an asset side panel on the right (drag the
          divider to resize). */}
      <div className="h-[680px] overflow-hidden rounded-xl border border-[var(--border-subtle)]">
        <ResizablePanel
          storageKey="activationRailPanelWidth"
          defaultRightWidth={460}
          minLeftWidth={320}
          minRightWidth={360}
          left={
            <div className="flex h-full flex-col gap-2 overflow-auto bg-[var(--surface-base)] p-4">
              {steps
                .filter((s) => s.moment <= moment)
                .map((s) => (
                  <div key={s.moment} className="flex flex-col gap-1">
                    <MomentLabel moment={s.moment} />
                    {s.node}
                  </div>
                ))}
            </div>
          }
          right={
            <div className="flex h-full flex-col bg-[var(--surface-lift)]">
              <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5">
                <Sparkles className="h-4 w-4 text-[var(--primary-base)]" />
                <span className="text-title-small text-[var(--content-strong)]">
                  What I know about you
                </span>
              </div>
              <div className="min-h-0 flex-1">
                <MemoryGraphView data={data} revealedIds={revealed} />
              </div>
            </div>
          }
        />
      </div>
    </div>
  );
}

export const FullRail: Story = {
  name: "Full rail (demo)",
  render: () => <RailDemo />,
};

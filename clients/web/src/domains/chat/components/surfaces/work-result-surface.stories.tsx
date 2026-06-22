import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import type { Surface } from "@/domains/chat/types/types";

import { SurfaceRouter } from "./surface-router";

const meta: Meta = {
  title: "Chat/Surfaces/WorkResult",
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <div className="max-w-[920px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj;

function makeWorkResultSurface(overrides: Partial<Surface> = {}): Surface {
  return {
    surfaceId: "work-result-surface",
    surfaceType: "work_result",
    title: "Inbox cleaned up",
    data: {},
    ...overrides,
  };
}

function WorkResultPreview({ surface }: { surface: Surface }) {
  const [currentSurface, setCurrentSurface] = useState(surface);
  return (
    <SurfaceRouter
      surface={currentSurface}
      onAction={(_surfaceId, actionId) => {
        const action = currentSurface.actions?.find(
          (item) => item.id === actionId,
        );
        setCurrentSurface((current) => ({
          ...current,
          completed: true,
          completionSummary: action?.label
            ? `${action.label} selected`
            : "Action selected",
        }));
      }}
    />
  );
}

const inboxCleanupSurface = makeWorkResultSurface({
  title: "Inbox cleaned up",
  data: {
    eyebrow: "Moment 1 output",
    status: "completed",
    summary:
      "Archived low-signal newsletters, labeled receipts, and surfaced the two threads that actually need a reply.",
    metrics: [
      { label: "Archived", value: 31, tone: "positive" },
      {
        label: "Labeled",
        value: 7,
        detail: "Receipts + travel",
        tone: "neutral",
      },
      { label: "Needs reply", value: 2, tone: "warning" },
    ],
    sections: [
      {
        id: "attention",
        title: "Needs attention",
        type: "items",
        items: [
          {
            id: "contract",
            title: "Contract follow-up",
            description:
              "Alice asked for edits before tomorrow's vendor review.",
            status: "Reply today",
            tone: "warning",
            metadata: [
              { label: "Mailbox", value: "Work" },
              { label: "Age", value: "1 day" },
            ],
          },
          {
            id: "flight",
            title: "Flight change confirmation",
            description:
              "The airline moved the return flight earlier by 45 minutes.",
            status: "Review",
            tone: "warning",
            metadata: [{ label: "Trip", value: "June offsite" }],
          },
        ],
      },
      {
        id: "changes",
        title: "What changed",
        type: "timeline",
        items: [
          {
            id: "newsletters",
            title: "Archived recurring newsletters",
            description: "27 threads from senders you never opened this month.",
            tone: "positive",
          },
          {
            id: "receipts",
            title: "Labeled receipts",
            description: "4 purchase confirmations moved under Receipts.",
            tone: "positive",
          },
        ],
      },
    ],
  },
  actions: [
    {
      id: "review",
      label: "Review",
      style: "primary",
      data: { next: "review_inbox" },
    },
    { id: "undo", label: "Undo", data: { next: "undo_inbox_cleanup" } },
  ],
});

const calendarPlanSurface = makeWorkResultSurface({
  surfaceId: "calendar-plan-result",
  title: "Week reshaped",
  data: {
    status: "completed",
    summary:
      "Moved meetings away from deep work blocks and left one decision for you because it affects another person.",
    metrics: [
      { label: "Focus blocks", value: 5, tone: "positive" },
      { label: "Conflicts fixed", value: 3, tone: "positive" },
      { label: "Needs approval", value: 1, tone: "warning" },
    ],
    sections: [
      {
        id: "timeline",
        title: "Schedule changes",
        type: "timeline",
        items: [
          {
            id: "monday",
            title: "Protected Monday morning",
            description: "Moved two internal check-ins after lunch.",
            tone: "positive",
          },
          {
            id: "wednesday",
            title: "Cleared Wednesday writing block",
            description: "Converted a sync into async notes.",
            tone: "positive",
          },
          {
            id: "friday",
            title: "Left Friday partner review unchanged",
            description: "Moving it would collide with Bob's calendar.",
            tone: "warning",
            status: "Ask first",
          },
        ],
      },
      {
        id: "warnings",
        title: "Open decision",
        type: "warnings",
        items: [
          {
            id: "partner-review",
            title: "Friday review could move to 2:30 PM",
            description:
              "It creates a cleaner afternoon, but the invite includes an external attendee.",
            tone: "warning",
          },
        ],
      },
    ],
  },
  actions: [
    { id: "ask", label: "Ask Bob", style: "primary" },
    { id: "leave", label: "Leave it" },
  ],
});

const documentDraftSurface = makeWorkResultSurface({
  surfaceId: "document-draft-result",
  title: "Launch memo tightened",
  data: {
    status: "completed",
    summary:
      "Turned the rough launch notes into a decision memo with a sharper ask and a shorter executive summary.",
    metrics: [
      { label: "Words removed", value: 420, tone: "positive" },
      { label: "Open comments", value: 3, tone: "warning" },
      { label: "Sections", value: 5, tone: "neutral" },
    ],
    sections: [
      {
        id: "diff",
        title: "Important rewrite",
        type: "diff",
        diffs: [
          {
            label: "Executive ask",
            before:
              "We should probably consider launching the beta if the team feels ready.",
            after:
              "Approve a 20-user beta next week with support coverage limited to weekdays.",
          },
          {
            label: "Risk framing",
            before: "There are some support risks.",
            after:
              "The main risk is support volume, mitigated by a hard beta cap and a published response window.",
          },
        ],
      },
      {
        id: "artifact",
        title: "Created artifact",
        type: "artifacts",
        items: [
          {
            id: "memo",
            title: "Beta launch decision memo",
            description: "Saved in the project workspace.",
            tone: "positive",
            href: "#",
            metadata: [
              { label: "Format", value: "Document" },
              { label: "Status", value: "Draft" },
            ],
          },
        ],
      },
    ],
  },
  actions: [
    { id: "open", label: "Open memo", style: "primary" },
    { id: "comments", label: "Review comments" },
  ],
});

const automationSetupSurface = makeWorkResultSurface({
  surfaceId: "automation-setup-result",
  title: "Morning briefing scheduled",
  data: {
    status: "completed",
    summary:
      "Set up a weekday briefing that checks calendar risk, urgent messages, and the project board before work starts.",
    metrics: [
      { label: "Sources", value: 4, tone: "neutral" },
      { label: "Runs", value: "Weekdays", tone: "positive" },
      { label: "First run", value: "Tomorrow", tone: "positive" },
    ],
    sections: [
      {
        id: "steps",
        title: "Automation pieces",
        type: "timeline",
        items: [
          {
            id: "calendar",
            title: "Calendar risk check",
            description: "Looks for conflicts and meetings without prep.",
            tone: "positive",
          },
          {
            id: "mail",
            title: "Urgent message scan",
            description: "Flags threads that need a same-day reply.",
            tone: "positive",
          },
          {
            id: "tasks",
            title: "Project board pulse",
            description: "Summarizes blockers and items due today.",
            tone: "positive",
          },
        ],
      },
      {
        id: "boundaries",
        title: "Boundaries",
        type: "warnings",
        items: [
          {
            id: "approval",
            title: "Draft-only for outbound messages",
            description:
              "The assistant will prepare replies but will not send them without approval.",
            tone: "warning",
          },
        ],
      },
    ],
  },
  actions: [
    { id: "preview", label: "Preview tomorrow", style: "primary" },
    { id: "edit", label: "Edit sources" },
  ],
});

const oauthConsentSurface = makeWorkResultSurface({
  surfaceId: "oauth-sequence-result",
  title: "Google connected for inbox cleanup",
  data: {
    status: "completed",
    summary:
      "Connected Google at the point of need, then used the granted account to run the inbox cleanup.",
    metrics: [
      { label: "Connection", value: "Google", tone: "positive" },
      { label: "OAuth mode", value: "Managed", tone: "neutral" },
      { label: "User approvals", value: 2, tone: "positive" },
    ],
    sections: [
      {
        id: "sequence",
        title: "Consent and execution path",
        type: "timeline",
        items: [
          {
            id: "choice",
            title: "Inbox cleanup selected",
            description:
              "The assistant requested Google only after the user chose account-backed work.",
            tone: "positive",
          },
          {
            id: "connect",
            title: "Google connected",
            description:
              "The managed OAuth surface handled consent without sending the user to settings.",
            tone: "positive",
          },
          {
            id: "run",
            title: "Inbox cleanup ran",
            description:
              "The assistant used the connected account to archive noise and surface reply threads.",
            tone: "positive",
          },
        ],
      },
      {
        id: "guardrails",
        title: "Guardrails",
        type: "warnings",
        items: [
          {
            id: "approval",
            title: "No silent account work",
            description:
              "The assistant waits for the connect surface to complete before running account-backed tools.",
            tone: "warning",
          },
        ],
      },
    ],
  },
});

const researchSynthesisSurface = makeWorkResultSurface({
  surfaceId: "research-result",
  title: "Research condensed",
  data: {
    status: "completed",
    summary:
      "Collapsed the open notes into three claims, two unresolved questions, and one recommended next decision.",
    metrics: [
      { label: "Notes read", value: 18, tone: "neutral" },
      { label: "Claims", value: 3, tone: "positive" },
      { label: "Open questions", value: 2, tone: "warning" },
    ],
    sections: [
      {
        id: "claims",
        title: "Strongest claims",
        type: "items",
        items: [
          {
            id: "claim-1",
            title: "Users understand the value after seeing real work",
            description:
              "The strongest signal appears after the assistant changes something visible.",
            tone: "positive",
            metadata: [{ label: "Confidence", value: "High" }],
          },
          {
            id: "claim-2",
            title: "Menus underperform single recommended outcomes",
            description:
              "Open-ended offers make users defer; concrete recommendations get acted on.",
            tone: "positive",
            metadata: [{ label: "Confidence", value: "Medium" }],
          },
        ],
      },
      {
        id: "questions",
        title: "Still unresolved",
        type: "warnings",
        items: [
          {
            id: "question-1",
            title: "How much context is enough before the first outcome?",
            description:
              "The notes disagree on whether the port step should always come first.",
            tone: "warning",
          },
          {
            id: "question-2",
            title: "Which work receipt gets users to trust the run?",
            description:
              "Inbox cleanup and calendar reshaping show different kinds of proof.",
            tone: "warning",
          },
        ],
      },
    ],
  },
  actions: [
    { id: "decision", label: "Pick a direction", style: "primary" },
    { id: "sources", label: "Show sources" },
  ],
});

const partialFailureSurface = makeWorkResultSurface({
  surfaceId: "partial-result",
  title: "Drive organized, with two skips",
  data: {
    status: "partial",
    summary:
      "Renamed the files it could identify confidently and left ambiguous items untouched.",
    metrics: [
      { label: "Renamed", value: 14, tone: "positive" },
      { label: "Moved", value: 9, tone: "positive" },
      { label: "Skipped", value: 2, tone: "warning" },
    ],
    sections: [
      {
        id: "done",
        title: "Completed",
        type: "artifacts",
        items: [
          {
            id: "contracts",
            title: "Vendor contracts folder",
            description: "Grouped signed PDFs and renewal drafts.",
            tone: "positive",
            metadata: [{ label: "Files", value: 8 }],
          },
          {
            id: "receipts",
            title: "Receipts folder",
            description: "Moved purchase confirmations into month folders.",
            tone: "positive",
            metadata: [{ label: "Files", value: 6 }],
          },
        ],
      },
      {
        id: "skipped",
        title: "Skipped",
        type: "warnings",
        items: [
          {
            id: "scan",
            title: "scan-final-final.pdf",
            description:
              "Could be a contract or an invoice; leaving it untouched avoids a bad move.",
            tone: "warning",
          },
          {
            id: "image",
            title: "IMG_2048.png",
            description: "No readable text or surrounding context.",
            tone: "warning",
          },
        ],
      },
    ],
  },
  actions: [
    { id: "resolve", label: "Resolve skips", style: "primary" },
    { id: "done", label: "Looks good" },
  ],
});

const compactMetricsSurface = makeWorkResultSurface({
  surfaceId: "metrics-only-result",
  title: "Newsletter triage complete",
  data: {
    status: "completed",
    summary: "Applied the rule to the backlog and left the inbox clear.",
    metrics: [
      { label: "Archived", value: 86, tone: "positive" },
      { label: "Senders muted", value: 12, tone: "positive" },
      { label: "Kept", value: 4, tone: "neutral" },
    ],
  },
});

const activationPortPromptSurface: Surface = {
  surfaceId: "copy-block-port",
  surfaceType: "copy_block",
  data: {
    label: "Assistant migration prompt",
    language: "text",
    text: "Summarize what you know about my work style, recurring tasks, preferences, and workflows that a new assistant should carry forward. Keep it concise but specific.",
  },
};

const activationOutcomeChoiceSurface: Surface = {
  surfaceId: "activation-choice",
  surfaceType: "choice",
  title: "Pick the first useful run",
  data: {
    description:
      "Choose where the assistant should spend the next few minutes.",
    options: [
      {
        id: "inbox",
        title: "Clean up my inbox",
        description: "Archive noise and surface the threads that need action.",
        recommended: true,
      },
      {
        id: "calendar",
        title: "Protect my week",
        description: "Move low-value meetings away from focus time.",
      },
    ],
  },
};

const activationFollowThroughSurface: Surface = {
  surfaceId: "activation-follow-through",
  surfaceType: "choice",
  title: "Next best move",
  data: {
    description: "The inbox cleanup exposed one obvious follow-through.",
    options: [
      {
        id: "draft-replies",
        title: "Draft the two replies",
        description: "Prepare responses for review without sending.",
        recommended: true,
      },
      {
        id: "setup-briefing",
        title: "Make this a morning briefing",
        description: "Run a lighter version every weekday.",
      },
    ],
  },
};

export const InboxCleanup: Story = {
  render: () => <WorkResultPreview surface={inboxCleanupSurface} />,
};

export const CalendarPlanning: Story = {
  render: () => <WorkResultPreview surface={calendarPlanSurface} />,
};

export const DocumentDiff: Story = {
  render: () => <WorkResultPreview surface={documentDraftSurface} />,
};

export const AutomationSetup: Story = {
  render: () => <WorkResultPreview surface={automationSetupSurface} />,
};

export const OAuthConsentResult: Story = {
  render: () => <WorkResultPreview surface={oauthConsentSurface} />,
};

export const ResearchSynthesis: Story = {
  render: () => <WorkResultPreview surface={researchSynthesisSurface} />,
};

export const PartialFailure: Story = {
  render: () => <WorkResultPreview surface={partialFailureSurface} />,
};

export const CompactMetricsOnly: Story = {
  render: () => <WorkResultPreview surface={compactMetricsSurface} />,
};

export const ActivationRunStack: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <SurfaceRouter
        surface={activationPortPromptSurface}
        onAction={() => {}}
      />
      <SurfaceRouter
        surface={activationOutcomeChoiceSurface}
        onAction={() => {}}
      />
      <WorkResultPreview surface={inboxCleanupSurface} />
      <SurfaceRouter
        surface={activationFollowThroughSurface}
        onAction={() => {}}
      />
    </div>
  ),
};

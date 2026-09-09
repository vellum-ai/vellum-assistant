import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { userEvent, within } from "storybook/test";

import type { Surface } from "@/domains/chat/types/types";

import { TranscriptColumn } from "@/domains/chat/transcript/transcript-column";

import { SurfaceRouter } from "./surface-router";

/**
 * The card a Watch (teach mode) session ends on, one page at a time.
 *
 * Rendered through `SurfaceRouter` rather than by importing the component,
 * because the retro rides an ordinary `card` under a `watch_retro` template
 * and the template dispatch is part of what these stories are showing. A
 * renderer that did not know the template would draw `title`/`subtitle`/`body`
 * instead, which is the fallback the payload carries for older clients.
 *
 * Page one is always the record. Stories that are about a question page use a
 * `play` step to tap past it, so the page under discussion is the one on
 * screen when the story opens.
 */
const meta: Meta = {
  title: "Chat/Surfaces/WatchRetro",
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

/** The card's `templateData`, which is the whole of the report. */
type RetroTemplateData = Record<string, unknown>;

function retroSurface(templateData: RetroTemplateData): Surface {
  const task = (templateData.task as string | undefined) ?? "";
  const steps = (templateData.steps as string[] | undefined) ?? [];
  return {
    surfaceId: "watch-retro-story",
    surfaceType: "card",
    title: task,
    data: {
      // Derived the way `watch-retro.ts` derives them, so the degraded view a
      // template-unaware renderer would draw stays visible in Storybook too.
      title: task,
      ...(templateData.purpose ? { subtitle: templateData.purpose } : {}),
      body: steps.map((step, index) => `${index + 1}. ${step}`).join("\n"),
      template: "watch_retro",
      templateData,
    },
  } as Surface;
}

/**
 * The card with its answers wired up, so tapping through the pages behaves the
 * way it does in a conversation. The submitted payload is logged rather than
 * sent, and the surface is completed with the summary the card asked for,
 * which is what the daemon echoes back, so the collapsed row is visible.
 */
function RetroPreview({
  templateData,
  completed = false,
}: {
  templateData: RetroTemplateData;
  /** Open on the collapsed row, as a restored conversation would. */
  completed?: boolean;
}) {
  const [surface, setSurface] = useState(() => ({
    ...retroSurface(templateData),
    ...(completed ? { completed: true, completionSummary: "Skill saved" } : {}),
  }));
  const [submitted, setSubmitted] = useState<unknown>(null);

  return (
    <div className="flex flex-col gap-3">
      <SurfaceRouter
        surface={surface}
        onAction={(_surfaceId, actionId, data) => {
          setSubmitted({ actionId, ...data });
          setSurface((current) => ({
            ...current,
            completed: true,
            completionSummary:
              typeof data?._completionSummary === "string"
                ? data._completionSummary
                : undefined,
          }));
        }}
      />
      {submitted !== null && (
        <pre className="overflow-x-auto rounded-lg bg-[var(--surface-overlay)] p-3 text-body-small-default text-[var(--content-quiet)]">
          {JSON.stringify(submitted, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** Tap off the recap, so the story opens on the first question. */
async function toFirstQuestion(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByText("Looks right"));
}

const TRIGGER_QUESTION = {
  id: "trigger",
  kind: "fill",
  eyebrow: "Trigger",
  prompt: "What would you say to start this?",
  suggestion: "file this Sentry bug",
};

const PRIORITY_QUESTION = {
  id: "priority",
  kind: "pick",
  eyebrow: "Priority",
  prompt: "You set this one to High. What decides that?",
  options: [
    {
      id: "events",
      label: "Over 100 events in an hour",
      note: "What the recording shows",
    },
    { id: "customer", label: "It touched a customer account" },
    { id: "ask", label: "Ask me each time" },
  ],
};

const RESOLVE_QUESTION = {
  id: "resolve",
  kind: "gate",
  eyebrow: "Resolving",
  prompt: "Resolving the Sentry issue once the ticket exists, on my own?",
  options: [
    { id: "confirm", label: "Ask me first", note: "The safer default" },
    { id: "auto", label: "Go ahead and resolve it" },
  ],
};

const FULL_REPORT: RetroTemplateData = {
  task: "Filing a Linear bug from a Sentry alert",
  purpose: "So an overnight crash has a ticket by morning.",
  eyebrow: "Taught in 4 min, 11 screens",
  steps: [
    "Open the Sentry issue from the alert email",
    "Copy the stack trace and the first-seen timestamp",
    "Open a new Linear issue in JARVIS",
    "Paste the trace into the description",
    "Set priority and assign to the on-call engineer",
    "Paste the Linear link back into the Sentry issue",
  ],
  questions: [TRIGGER_QUESTION, PRIORITY_QUESTION, RESOLVE_QUESTION],
};

/**
 * The whole flow: record, then three questions, then a submitted payload.
 * The one to open when the question is how the card feels to tap through.
 */
export const FullWalkthrough: Story = {
  render: () => <RetroPreview templateData={FULL_REPORT} />,
};

/**
 * The record with nothing optional set. No eyebrow, no purpose, no coverage
 * line, and no questions, so the progress bar is gone and the card is only
 * what was seen.
 */
export const RecordOnly: Story = {
  render: () => (
    <RetroPreview
      templateData={{
        task: "Restarting the staging worker",
        steps: [
          "Open the deploy dashboard",
          "Select the staging worker",
          "Restart it and wait for green",
        ],
      }}
    />
  ),
};

/**
 * A session the recording only partly covers. The coverage line is where that
 * is said, rather than hedged inside the steps.
 */
export const BoundedRecording: Story = {
  render: () => (
    <RetroPreview
      templateData={{
        task: "Triaging the overnight alert queue",
        purpose: "So the queue is empty before standup.",
        eyebrow: "Taught in 12 min, 40 screens",
        coverage:
          "The recording starts partway in, so the first few alerts are missing and nothing was seen about how the queue is opened.",
        steps: [
          "Sort the queue by first seen",
          "Open the oldest unacknowledged alert",
          "Acknowledge it and leave a one-line note",
        ],
      }}
    />
  ),
};

/**
 * A `pick`: named alternatives, the recording's own reading first and marked
 * as recommended. Nothing is selected until the user taps, and the tap is
 * what moves the card on.
 */
export const PickQuestion: Story = {
  render: () => (
    <RetroPreview
      templateData={{
        ...FULL_REPORT,
        questions: [PRIORITY_QUESTION],
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await toFirstQuestion(canvasElement);
  },
};

/**
 * A `gate`: a destructive step, with the cautious answer first because that
 * is the one shown as recommended.
 */
export const GateQuestion: Story = {
  render: () => (
    <RetroPreview
      templateData={{
        ...FULL_REPORT,
        questions: [RESOLVE_QUESTION],
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await toFirstQuestion(canvasElement);
  },
};

/**
 * A `fill`: the trigger phrase, pre-filled with the model's guess. The only
 * typing on the card, and the one field a recording cannot supply.
 */
export const FillQuestion: Story = {
  render: () => (
    <RetroPreview
      templateData={{
        ...FULL_REPORT,
        questions: [TRIGGER_QUESTION],
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await toFirstQuestion(canvasElement);
  },
};

/**
 * The card at its longest: eight steps, a long title, and options that wrap.
 * Where the paging is under the most pressure, so it is the story to check a
 * spacing or type change against.
 */
export const LongContent: Story = {
  render: () => (
    <RetroPreview
      templateData={{
        task: "Weekly competitor-intel digest",
        purpose: "So Monday's sync opens with the week already summarized.",
        eyebrow: "Taught in 18 min, 63 screens",
        coverage:
          "The recording ends before the digest was posted, so nothing was seen about which channel it goes to or who is tagged on it.",
        steps: [
          "Open the competitor-intel Slack channel",
          "Read everything posted since last Monday",
          "Open each linked article and skim for pricing or packaging changes",
          "Copy anything about pricing into the running doc",
          "Group the week's items by competitor",
          "Write a two-line summary for each competitor that moved",
          "Add the source links under each summary",
          "Read the whole thing back once before posting",
        ],
        questions: [
          {
            id: "scope",
            kind: "pick",
            eyebrow: "Scope",
            prompt:
              "Some weeks a competitor gets no mention at all. What decides whether one appears in the digest?",
            options: [
              {
                id: "moved",
                label: "Only competitors that did something new this week",
                note: "What the recording shows, since two were skipped",
              },
              {
                id: "all",
                label:
                  "Every competitor on the list, with 'no change' where there is nothing",
              },
              {
                id: "pricing",
                label: "Only pricing and packaging changes, whoever made them",
              },
            ],
          },
        ],
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await toFirstQuestion(canvasElement);
  },
};

/**
 * What a payload the model got wrong degrades to. The question's text arrived
 * under `question` rather than `prompt`, so it has no text at all and the card
 * drops it, leaving the record whole. Kept as a story because this is the
 * shape a live session produced, and the card has to stay presentable in it.
 */
export const UnusableQuestionDropped: Story = {
  render: () => (
    <RetroPreview
      templateData={{
        task: "Checking Slack between terminal work",
        eyebrow: "Taught in 14 sec",
        steps: [
          "Work in the terminal",
          "Switch to Slack",
          "Check for unread messages",
          "Switch back to the terminal",
        ],
        questions: [
          {
            id: "scope",
            kind: "pick",
            question: "Where does this routine end?",
            options: [{ value: "Just read" }, { value: "Also reply" }],
          },
        ],
      }}
    />
  ),
};

/**
 * What the card becomes once it has been answered, as a restored conversation
 * would show it: the task and one line saying what happened to it.
 */
export const Saved: Story = {
  render: () => <RetroPreview templateData={FULL_REPORT} completed />,
};

/**
 * The summary, reached by tapping through every question. The last page before
 * anything is saved, and the only place the session can be dropped.
 */
export const Summary: Story = {
  render: () => <RetroPreview templateData={FULL_REPORT} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText("Looks right"));
    await userEvent.click(await canvas.findByText("Next"));
    await userEvent.click(
      await canvas.findByText("Over 100 events in an hour"),
    );
    await userEvent.click(await canvas.findByText("Ask me first"));
  },
};

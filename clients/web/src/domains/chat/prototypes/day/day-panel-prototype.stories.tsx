/**
 * Design prototypes for what replaces the recent conversations list.
 *
 * The premise: most conversations are never reopened, so a list of them is
 * history posing as navigation. These stories try the panel as a view of the
 * day instead: what is on the calendar, what the assistant is doing, what
 * needs the user, what got done. Every item opens a thread on the right, so
 * a conversation is one click from the thing it is about rather than a title
 * in a list.
 *
 * `panelMode` switches between the arrangements; the rest of the knobs tune
 * one. Drag `nowHour` to move the day forward and back.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  DEFAULT_DAY_PANEL_OPTIONS,
  DayPanelPrototype,
} from "./day-panel-prototype";

const meta: Meta<typeof DayPanelPrototype> = {
  title: "Chat/Prototypes/Day Panel",
  component: DayPanelPrototype,
  tags: ["!autodocs"],
  parameters: { layout: "fullscreen" },
  args: { ...DEFAULT_DAY_PANEL_OPTIONS, initialSelectedId: null },
  argTypes: {
    panelMode: {
      control: "radio",
      options: ["recents", "timeline", "loops", "agenda", "combined"],
      description:
        "recents = shipped list (control). timeline = by day. loops = in flight / needs you / done. agenda = today in time order. combined = agenda + needs you + done fold.",
      table: { category: "Panel" },
    },
    nowHour: {
      control: { type: "range", min: 7, max: 21, step: 0.25 },
      description:
        "Where the now line sits. Moves the past and future of the day.",
      table: { category: "Panel" },
    },
    pastTreatment: {
      control: "radio",
      options: ["fade", "collapse", "show"],
      description: "How items earlier than now are drawn in the agenda.",
      table: { category: "Panel" },
    },
    needsYouFirst: { control: "boolean", table: { category: "Panel" } },
    showDoneToday: { control: "boolean", table: { category: "Panel" } },
    timelineOpenGroups: {
      control: { type: "range", min: 0, max: 4, step: 1 },
      description: "Timeline mode: day groups open by default.",
      table: { category: "Panel" },
    },
    showAssistantNotes: {
      control: "boolean",
      description:
        "The assistant's note under items it has something to say about.",
      table: { category: "Assistant" },
    },
    showActual: {
      control: "boolean",
      description:
        "On planned blocks, what the assistant recorded actually happening.",
      table: { category: "Assistant" },
    },
    calendarColors: { control: "boolean", table: { category: "Look" } },
    density: {
      control: "radio",
      options: ["comfortable", "compact"],
      table: { category: "Look" },
    },
    panelWidth: {
      control: { type: "range", min: 240, max: 400, step: 10 },
      table: { category: "Look" },
    },
    initialSelectedId: {
      control: "select",
      options: [
        null,
        "launch-review",
        "block-email",
        "soccer",
        "domain",
        "one-on-one",
      ],
      description: "Open this item on load.",
      table: { category: "Behavior" },
    },
    seed: { table: { disable: true } },
  },
};

export default meta;
type Story = StoryObj<typeof DayPanelPrototype>;

/** The shipped list, for comparison. Same day, same items, no structure. */
export const Recents: Story = {
  args: { panelMode: "recents" },
};

/**
 * The cheapest change: the same list grouped by day, with everything before
 * today folded. Less noise, same idea.
 */
export const Timeline: Story = {
  args: { panelMode: "timeline", timelineOpenGroups: 1 },
};

/**
 * The panel as open loops: what the assistant is doing, what is waiting on
 * the user, what got done. Conversations become the record of a task and
 * fold away when it completes. Tick a task to see it move.
 */
export const OpenLoops: Story = {
  args: { panelMode: "loops" },
};

/**
 * The panel as today. Events across three calendars, the blocks the user
 * planned with what actually happened in them, reminders, and the assistant's
 * notes (brief ready, conflict, leave by). Selecting anything opens a thread
 * about it. Drag `nowHour` to move through the day.
 */
export const Agenda: Story = {
  args: { panelMode: "agenda" },
};

/**
 * Agenda with the past folded rather than faded, so the panel is only what
 * is still ahead.
 */
export const AgendaAheadOnly: Story = {
  args: { panelMode: "agenda", pastTreatment: "collapse" },
};

/**
 * The combination: what needs you on top, today in the middle, done folded
 * at the bottom. The current best guess at a shipping shape.
 */
export const Combined: Story = {
  args: { panelMode: "combined", initialSelectedId: "soccer" },
};

/**
 * A planned block opened: the plan-vs-actual bar and the assistant's record
 * of what the time went to.
 */
export const BlockOpened: Story = {
  args: {
    panelMode: "combined",
    initialSelectedId: "block-email",
    nowHour: 11.5,
  },
};

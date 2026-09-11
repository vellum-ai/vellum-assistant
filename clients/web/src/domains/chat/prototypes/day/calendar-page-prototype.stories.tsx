/**
 * Design prototype: the calendar as a surface the assistant lives on.
 *
 * Events across work, personal, and family calendars on one day grid; the
 * blocks the user planned, filled by how much of them went to plan; the
 * assistant's comments pinned on the events it has something to say about;
 * and a thread drawer on any of them. The chips above the grid are the
 * assistant's untimed items (things it is holding or needs a decision on).
 *
 * Drag `nowHour` to move through the day. Toggle calendars to see the
 * "combine my calendars" case collapse to one.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  CalendarPagePrototype,
  DEFAULT_CALENDAR_PAGE_OPTIONS,
} from "./calendar-page-prototype";

const meta: Meta<typeof CalendarPagePrototype> = {
  title: "Chat/Prototypes/Calendar Page",
  component: CalendarPagePrototype,
  tags: ["!autodocs"],
  parameters: { layout: "fullscreen" },
  args: { ...DEFAULT_CALENDAR_PAGE_OPTIONS, initialOpenId: null },
  argTypes: {
    nowHour: {
      control: { type: "range", min: 7, max: 21, step: 0.25 },
      table: { category: "Day" },
    },
    startHour: {
      control: { type: "range", min: 0, max: 12, step: 1 },
      table: { category: "Day" },
    },
    endHour: {
      control: { type: "range", min: 13, max: 24, step: 1 },
      table: { category: "Day" },
    },
    hourHeight: {
      control: { type: "range", min: 40, max: 120, step: 4 },
      table: { category: "Day" },
    },
    showWeekStrip: { control: "boolean", table: { category: "Day" } },
    showComments: {
      control: "boolean",
      description: "The assistant's comments on events.",
      table: { category: "Assistant" },
    },
    commentPlacement: {
      control: "radio",
      options: ["inside", "margin"],
      description:
        "Comments inside the event card, or in a margin column beside the grid (Google Docs style).",
      table: { category: "Assistant" },
    },
    showActual: {
      control: "boolean",
      description: "Fill planned blocks by how much of them went to plan.",
      table: { category: "Assistant" },
    },
    showWork: { control: "boolean", table: { category: "Calendars" } },
    showPersonal: { control: "boolean", table: { category: "Calendars" } },
    showFamily: { control: "boolean", table: { category: "Calendars" } },
    calendarColors: { control: "boolean", table: { category: "Calendars" } },
    drawerWidth: {
      control: { type: "range", min: 320, max: 640, step: 10 },
      table: { category: "Thread" },
    },
    initialOpenId: {
      control: "select",
      options: [
        null,
        "launch-review",
        "soccer",
        "block-email",
        "one-on-one",
        "domain",
      ],
      table: { category: "Thread" },
    },
    seed: { table: { disable: true } },
  },
};

export default meta;
type Story = StoryObj<typeof CalendarPagePrototype>;

/** The day, mid-afternoon, comments on the cards. */
export const Day: Story = {};

/**
 * Comments in a margin column beside the grid instead of inside the cards,
 * so the grid stays a calendar and the assistant's voice sits next to it.
 */
export const MarginComments: Story = {
  args: { commentPlacement: "margin" },
};

/**
 * The conflict the assistant flagged, opened: soccer practice starts as the
 * 1:1 ends, and the thread is where the user decides what to do about it.
 */
export const ConflictOpened: Story = {
  args: { initialOpenId: "soccer" },
};

/**
 * Morning: everything is still ahead, the launch email block has not
 * happened yet, and the briefs are ready.
 */
export const Morning: Story = {
  args: { nowHour: 8.5 },
};

/**
 * Evening: the day as a record. Blocks show how much of them went to plan.
 */
export const Evening: Story = {
  args: { nowHour: 18.75 },
};

/** Work calendar only, the way a work-only user would see it. */
export const WorkOnly: Story = {
  args: { showPersonal: false, showFamily: false },
};

/**
 * Design prototype: the left panel as a list that gets shorter.
 *
 * The by-day timeline's vocabulary (title, time chip, fold with a count) and
 * nothing else, plus one idea: progression. TODAY holds what is still open.
 * Closing an item takes it off the list and bumps the DONE count. Three
 * things close items: the user (hover, check), the assistant (a task it
 * finishes closes itself a few seconds after load), and the clock (an event
 * whose time has passed; drag `nowHour` to watch the list empty).
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  DEFAULT_TODAY_PANEL_OPTIONS,
  TodayPanelPrototype,
} from "./today-panel-prototype";

const meta: Meta<typeof TodayPanelPrototype> = {
  title: "Chat/Prototypes/Today Panel",
  component: TodayPanelPrototype,
  tags: ["!autodocs"],
  parameters: { layout: "fullscreen" },
  args: { ...DEFAULT_TODAY_PANEL_OPTIONS, initialSelectedId: null },
  argTypes: {
    nowHour: {
      control: { type: "range", min: 7, max: 22, step: 0.25 },
      description: "Events before now have passed and leave the list.",
      table: { category: "Progression" },
    },
    closeAffordance: {
      control: "radio",
      options: ["hover-check", "chip-check", "none"],
      description:
        "hover-check = a check beside the chip on hover. chip-check = the time chip itself turns into the check.",
      table: { category: "Progression" },
    },
    progress: {
      control: "radio",
      options: ["count", "line", "none"],
      description:
        "count = the DONE number. line = a hairline under TODAY that fills.",
      table: { category: "Progression" },
    },
    done: {
      control: "radio",
      options: ["fold", "hidden"],
      table: { category: "Progression" },
    },
    autoCloseDemo: {
      control: "boolean",
      description:
        "The running task finishes 4.5s after load and leaves the list.",
      table: { category: "Progression" },
    },
    timeChip: {
      control: "radio",
      options: ["always", "hover", "none"],
      table: { category: "Look" },
    },
    emphasizeNeedsYou: {
      control: "boolean",
      description:
        "Bold the items waiting on you. The only emphasis in the list.",
      table: { category: "Look" },
    },
    showAssistantWorking: {
      control: "boolean",
      description: "A quiet pulse in place of the time on a running task.",
      table: { category: "Look" },
    },
    pastFolds: { control: "boolean", table: { category: "Look" } },
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
      options: [null, "launch-review", "one-on-one", "domain", "retro-notes"],
      table: { category: "Behavior" },
    },
    seed: { table: { disable: true } },
  },
};

export default meta;
type Story = StoryObj<typeof TodayPanelPrototype>;

/**
 * Mid-afternoon. Hover a row for the check; watch the running task close
 * itself; open DONE to see what left.
 */
export const Default: Story = {};

/** The time chip is the check: nothing extra appears on hover. */
export const ChipIsTheCheck: Story = {
  args: { closeAffordance: "chip-check" },
};

/** A hairline under TODAY fills as the day closes out. */
export const ProgressLine: Story = {
  args: { progress: "line" },
};

/** No times at all. Titles and counts only. */
export const NoTimes: Story = {
  args: { timeChip: "none", emphasizeNeedsYou: false },
};

/** Morning: the whole day still open. */
export const Morning: Story = {
  args: { nowHour: 8, autoCloseDemo: false },
};

/** End of day: the clock has closed nearly everything. */
export const EndOfDay: Story = {
  args: { nowHour: 21.5 },
};

/** Nothing but today. No past folds, no done fold. */
export const Bare: Story = {
  args: { pastFolds: false, done: "hidden", timeChip: "hover" },
};

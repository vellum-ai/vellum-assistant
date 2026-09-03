/**
 * One checklist row in each of the states the daemon can put it in
 * (Figma: New-App `8300:168063`, `8300:168080`, `8300:166573`, `8300:166806`,
 * `8300:166819`).
 *
 * The row is the piece the modal and the full list page both render, so it is
 * worth reading on its own: the expanded body is where the chip, the custom
 * field and the send button have to sit together without the field's right
 * edge colliding with the button, and the working and done states are where a
 * long description has to share the row with a status pill.
 *
 * Every fixture is the wire shape `GET /v1/activation/progress` returns, so a
 * row here cannot show a combination the daemon could never produce.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  doneTaskProgress,
  doneWithArtifactProgress,
  startedTaskProgress,
} from "@/domains/activation/activation-test-fixtures";
import { getActivationList } from "@/domains/activation/catalog";
import { ActivationTaskRow } from "@/domains/activation/components/activation-task-row";

const { starters, items } = getActivationList("smb");
const PDF_TASK = starters[0]!;
const RECAP_TASK = starters[1]!;
/** The one catalog entry carrying an external call to action. */
const COMPUTER_USE_TASK = items.find((task) => task.id === "try-computer-use")!;

const meta: Meta<typeof ActivationTaskRow> = {
  title: "Activation/ActivationTaskRow",
  component: ActivationTaskRow,
  parameters: { layout: "padded" },
  args: {
    task: PDF_TASK,
    expanded: false,
    onToggle: () => {},
    onLaunch: () => {},
    onOpenConversation: () => {},
  },
  argTypes: { task: { control: false }, progress: { control: false } },
  decorators: [
    (Story) => (
      // The row is measured against the modal's 440px body, which is the only
      // width its two-line descriptions were written for.
      <div className="w-full max-w-[408px] rounded-[var(--radius-md)] border border-[var(--border-base)] bg-[var(--surface-lift)]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ActivationTaskRow>;

/** An untouched task, closed. Clicking the row opens it. */
export const TodoCollapsed: Story = {};

/** The same task open: the suggested chip, then a field for anything else. */
export const TodoExpanded: Story = {
  args: { expanded: true },
};

/**
 * A task whose catalog entry carries an external call to action. The link is
 * hidden inside the desktop app, where the page it points at is a download
 * page for the app the reader is already in.
 */
export const TodoExpandedWithLink: Story = {
  args: { task: COMPUTER_USE_TASK, expanded: true },
};

/** The row while its launch is in flight: every control locked. */
export const TodoExpandedPending: Story = {
  args: { expanded: true, pending: true },
};

/** A task the assistant is working, counting its tool calls as it goes. */
export const Working: Story = {
  args: { progress: startedTaskProgress() },
};

/** A finished task whose turn produced a file, which the row hands back. */
export const DoneWithFile: Story = {
  args: { progress: doneWithArtifactProgress() },
};

/** A finished task with nothing to hand back, so the row says how it went. */
export const DoneWithPill: Story = {
  args: { task: RECAP_TASK, progress: doneTaskProgress() },
};

/** The expanded row on the dark ground, where the chip and field invert. */
export const TodoExpandedDark: Story = {
  args: { expanded: true },
  globals: { theme: "dark" },
};

/** The finished row on the dark ground, where the check has to stay legible. */
export const DoneWithFileDark: Story = {
  args: { progress: doneWithArtifactProgress() },
  globals: { theme: "dark" },
};

/** The expanded row at phone width, where the field loses the most room. */
export const TodoExpandedMobile: Story = {
  args: { expanded: true },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

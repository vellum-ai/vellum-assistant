/**
 * One checklist row in each of the states the daemon can put it in
 * (Figma: New-App `8300:168063`, `8300:168080`, `8300:166573`, `8300:166806`,
 * `8300:166819`).
 *
 * The row is the piece the modal and the full list page both render, so it is
 * worth reading on its own: the expanded body is where the chip, the custom
 * field and the send button have to sit together without the field's right
 * edge colliding with the button, and the working and done states are where a
 * long description has to share the row with a status pill. The `list` stories
 * at the end are the same row on the Inspiration List, which has no accordion
 * (Figma: New-App `8300:167483`, `8300:167749`).
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

/** The working row on the dark ground, where the spinner has least contrast. */
export const WorkingDark: Story = {
  args: { progress: startedTaskProgress() },
  globals: { theme: "dark" },
};

/** The working row at phone width, where the pill shares the narrowest row. */
export const WorkingMobile: Story = {
  args: { progress: startedTaskProgress() },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

/** The counted done row on the dark ground. */
export const DoneWithPillDark: Story = {
  args: { task: RECAP_TASK, progress: doneTaskProgress() },
  globals: { theme: "dark" },
};

/** The counted done row at phone width. */
export const DoneWithPillMobile: Story = {
  args: { task: RECAP_TASK, progress: doneTaskProgress() },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
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

/** The finished row at phone width, where the file card has least room. */
export const DoneWithFileMobile: Story = {
  args: { progress: doneWithArtifactProgress() },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

/** The expanded row at phone width, where the field loses the most room. */
export const TodoExpandedMobile: Story = {
  args: { expanded: true },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

/** The closed row on the dark ground, where the disc carries the only colour. */
export const TodoCollapsedDark: Story = {
  globals: { theme: "dark" },
};

/** The closed row at phone width, where the description wraps to three lines. */
export const TodoCollapsedMobile: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

/** The call to action on the dark ground, where the link is the only accent. */
export const TodoExpandedWithLinkDark: Story = {
  args: { task: COMPUTER_USE_TASK, expanded: true },
  globals: { theme: "dark" },
};

/** The call to action at phone width, where it wraps under the field. */
export const TodoExpandedWithLinkMobile: Story = {
  args: { task: COMPUTER_USE_TASK, expanded: true },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

/** The locked row on the dark ground, where the disabled controls flatten. */
export const TodoExpandedPendingDark: Story = {
  args: { expanded: true, pending: true },
  globals: { theme: "dark" },
};

/** The locked row at phone width, where the send button is tightest. */
export const TodoExpandedPendingMobile: Story = {
  args: { expanded: true, pending: true },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

/**
 * The Inspiration List's face of the row: a click is the launch, so there is
 * no body to open and the task's call to action shows straight away.
 */
export const ListTodo: Story = {
  args: { task: COMPUTER_USE_TASK, surface: "list" },
};

/** The list row on the dark ground, where its call to action has to hold. */
export const ListTodoDark: Story = {
  args: { task: COMPUTER_USE_TASK, surface: "list" },
  globals: { theme: "dark" },
};

/** The list row at phone width, where the call to action wraps first. */
export const ListTodoMobile: Story = {
  args: { task: COMPUTER_USE_TASK, surface: "list" },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

/** A launch the list has fired and the daemon has not answered for yet. */
export const ListPending: Story = {
  args: { surface: "list", pending: true },
};

/** The pending list row on the dark ground. */
export const ListPendingDark: Story = {
  args: { surface: "list", pending: true },
  globals: { theme: "dark" },
};

/** The pending list row at phone width. */
export const ListPendingMobile: Story = {
  args: { surface: "list", pending: true },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

/** A finished list row, where the file sits under the muted title. */
export const ListDoneWithFile: Story = {
  args: { surface: "list", progress: doneWithArtifactProgress() },
};

/** The finished list row on the dark ground. */
export const ListDoneWithFileDark: Story = {
  args: { surface: "list", progress: doneWithArtifactProgress() },
  globals: { theme: "dark" },
};

/** The finished list row at phone width, where the file card is tightest. */
export const ListDoneWithFileMobile: Story = {
  args: { surface: "list", progress: doneWithArtifactProgress() },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

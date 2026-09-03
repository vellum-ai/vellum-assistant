/**
 * The activation welcome modal, in the states the daemon walks it through
 * (Figma: New-App `8300:168003` for the canonical dark-header frame, and
 * `8300:166860` for the all-completed one).
 *
 * `Light800DarkHeader` is the frame the implementation is measured against.
 * The header is the part worth staring at: it bleeds to the modal's edges, the
 * greeting is the serif brand face rather than a title token, and the mascot
 * strip is cut off by the band's bottom edge rather than sitting above it.
 *
 * The band inverts between themes, which no single token can express, so the
 * dark stories here are not redundant with the theme toolbar: they are the
 * check that the light ground's inset text has a counterpart that still reads
 * (PLAN A16/A25).
 *
 * Every story runs against the real `smb` catalog and the wire shape
 * `GET /v1/activation/progress` returns. The launch path is live, so clicking
 * a chip in Storybook reports that no assistant is connected instead of
 * pretending to start one.
 */

import { useState, type ReactNode } from "react";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import {
  ACTIVATION_PROGRESS_ALL_DONE,
  ACTIVATION_PROGRESS_EMPTY,
  ACTIVATION_PROGRESS_ONE_WORKING,
  FIXTURE_STARTER_IDS,
  doneTaskProgress,
} from "@/domains/activation/activation-test-fixtures";
import { useActivationUiStore } from "@/domains/activation/activation-ui-store";
import type { ActivationProgress } from "@/domains/activation/hooks/use-activation-progress";
import { ActivationWelcomeModal } from "@/domains/activation/components/activation-welcome-modal";

/**
 * The accordion and the Show More disclosure live in an app-level store, so a
 * story would otherwise inherit whatever the last one left behind. Clearing it
 * before the modal mounts gives each story the state a first-time visitor
 * gets, and the modal seeds its own open row from there.
 */
function FreshUiStore({ children }: { children: ReactNode }): ReactNode {
  const [ready] = useState(() => {
    useActivationUiStore.setState({
      expandedTaskId: null,
      showMore: false,
      modalReopened: false,
    });
    return true;
  });
  return ready ? children : null;
}

const resetUiStore: Decorator = (Story) => (
  <FreshUiStore>
    <Story />
  </FreshUiStore>
);

/**
 * Every starter finished with nothing to show for it: no file, no step count.
 * The closest this implementation comes to the collapsed all-completed mock,
 * which drops the status pill entirely.
 */
const ALL_DONE_BARE: ActivationProgress = {
  ...ACTIVATION_PROGRESS_ALL_DONE,
  tasks: Object.fromEntries(
    FIXTURE_STARTER_IDS.map((taskId, index) => [
      taskId,
      doneTaskProgress({
        conversationId: `conv-done-${index + 1}`,
        stepCount: null,
      }),
    ]),
  ),
};

const meta: Meta<typeof ActivationWelcomeModal> = {
  title: "Activation/ActivationWelcomeModal",
  component: ActivationWelcomeModal,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    listId: "smb",
    progress: ACTIVATION_PROGRESS_EMPTY,
    variant: "welcome",
    onDismiss: () => {},
  },
  argTypes: {
    variant: { control: "inline-radio", options: ["welcome", "all-done"] },
    progress: { control: false },
  },
  decorators: [resetUiStore],
};

export default meta;
type Story = StoryObj<typeof ActivationWelcomeModal>;

/** The canonical frame: dark header, three starters, the first one open. */
export const Light800DarkHeader: Story = {};

/** The same frame on the dark ground, where the band becomes the sunken surface. */
export const Light800DarkHeaderDark: Story = {
  globals: { theme: "dark" },
};

/** The canonical frame as a bottom sheet, which is what a phone gets. */
export const Light800DarkHeaderMobile: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

/**
 * One task launched and still running. The row it came from has collapsed to
 * its step counter and the next unstarted row has opened underneath it, which
 * is the loop the whole surface exists for.
 */
export const Light799Working: Story = {
  args: { progress: ACTIVATION_PROGRESS_ONE_WORKING },
};

/** The working state on the dark ground. */
export const Light799WorkingDark: Story = {
  args: { progress: ACTIVATION_PROGRESS_ONE_WORKING },
  globals: { theme: "dark" },
};

/** The working state as a sheet. */
export const Light799WorkingMobile: Story = {
  args: { progress: ACTIVATION_PROGRESS_ONE_WORKING },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

/**
 * The celebration, with what each task produced still on the row: a file card
 * for the one that wrote a file, a step count for the ones that did not. There
 * is no way to put this off, only a way through to the full list.
 */
export const Light789AllDoneWithArtifacts: Story = {
  args: { variant: "all-done", progress: ACTIVATION_PROGRESS_ALL_DONE },
};

/** The celebration on the dark ground. */
export const Light789AllDoneWithArtifactsDark: Story = {
  args: { variant: "all-done", progress: ACTIVATION_PROGRESS_ALL_DONE },
  globals: { theme: "dark" },
};

/** The celebration as a sheet. */
export const Light789AllDoneWithArtifactsMobile: Story = {
  args: { variant: "all-done", progress: ACTIVATION_PROGRESS_ALL_DONE },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

/**
 * The shortest the celebration gets: three finished rows with nothing to hand
 * back and no counts, so each says only that it is done.
 */
export const Light789AllDoneCollapsed: Story = {
  args: { variant: "all-done", progress: ALL_DONE_BARE },
};

/** The same, dark. */
export const Light789AllDoneCollapsedDark: Story = {
  args: { variant: "all-done", progress: ALL_DONE_BARE },
  globals: { theme: "dark" },
};

/** The same, as a sheet. */
export const Light789AllDoneCollapsedMobile: Story = {
  args: { variant: "all-done", progress: ALL_DONE_BARE },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

/** Opens the disclosure the way a reader does, by clicking it. */
const openShowMore: Story["play"] = async ({ canvasElement }) => {
  // The modal portals out of the story root, so the query runs against the
  // document rather than the canvas element.
  const screen = within(canvasElement.ownerDocument.body);
  await userEvent.click(
    await screen.findByRole("button", { name: /Show More/ }),
  );
  await expect(
    await screen.findByText("Try computer use"),
  ).toBeInTheDocument();
};

/** The rest of the catalog, opened inline. The body scrolls; the header does not. */
export const ShowMoreExpanded: Story = {
  play: openShowMore,
};

/** The expanded catalog on the dark ground. */
export const ShowMoreExpandedDark: Story = {
  globals: { theme: "dark" },
  play: openShowMore,
};

/** The expanded catalog in the sheet, which is where the scroll matters most. */
export const ShowMoreExpandedMobile: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
  play: openShowMore,
};

/**
 * The one catalog row with an external call to action, opened in place: the
 * link sits under the description and above the chip, and never appears inside
 * the desktop app.
 */
const openComputerUse: Story["play"] = async (context) => {
  await openShowMore?.(context);
  const screen = within(context.canvasElement.ownerDocument.body);
  await userEvent.click(await screen.findByText("Try computer use"));
};

export const TodoExpandedWithLink: Story = {
  play: openComputerUse,
};

/** The linked row on the dark ground. */
export const TodoExpandedWithLinkDark: Story = {
  globals: { theme: "dark" },
  play: openComputerUse,
};

/** The linked row in the sheet. */
export const TodoExpandedWithLinkMobile: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
  play: openComputerUse,
};

/**
 * The Inspiration List, against the real `smb` catalog and the wire-shaped
 * progress fixtures the daemon returns.
 *
 * Two states are worth looking at, and they are the two Figma drew: a list
 * nobody has touched (Light 796), and one carrying every finished treatment at
 * once (Light 797). Each is repeated in dark and at 390px, which is where the
 * 600px column gives up its gutters and the serif title steps down.
 *
 * The list is long on purpose. The page scrolls inside the shell rather than
 * the window, and a short fixture would not show that.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  ACTIVATION_PROGRESS_EMPTY,
  ACTIVATION_PROGRESS_LIST_MIXED,
} from "@/domains/activation/activation-test-fixtures";
import { useActivationList } from "@/domains/activation/catalog";
import { ActivationListPage } from "@/domains/activation/components/activation-list-page";
import type { ActivationProgress } from "@/domains/activation/hooks/use-activation-progress";

/**
 * Resolves the real catalog the way the route does, so a story renders the
 * copy, icons and colors that ship rather than a hand-written stand-in.
 */
function ListPageDemo({ progress }: { progress?: ActivationProgress }) {
  const { starters, items } = useActivationList("smb");
  return (
    <ActivationListPage
      tasks={[...starters, ...items]}
      progress={progress?.tasks}
      onLaunch={() => {}}
      onOpenConversation={() => {}}
    />
  );
}

const meta: Meta<typeof ListPageDemo> = {
  title: "Activation/ActivationListPage",
  component: ListPageDemo,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      // The page fills the chat layout's outlet, which is a min-height-0 flex
      // column. Anything shorter hides the scroll behaviour.
      <div className="flex h-screen flex-col bg-[var(--surface-base)] p-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ListPageDemo>;

/** Light 796: nothing launched, every row offering itself. */
export const Light796Todo: Story = {
  args: { progress: ACTIVATION_PROGRESS_EMPTY },
};

/** The same list on a phone: full-bleed gutters and the smaller serif title. */
export const Light796TodoMobile: Story = {
  args: { progress: ACTIVATION_PROGRESS_EMPTY },
  globals: { viewport: { value: "sbMobile" } },
};

/** The untouched list in dark, where the tinted task discs are re-mixed. */
export const Light796TodoDark: Story = {
  args: { progress: ACTIVATION_PROGRESS_EMPTY },
  globals: { theme: "dark" },
};

/**
 * Light 797: the first task finished and produced a file, the second is still
 * running with a live step count, the third finished with nothing to show.
 */
export const Light797Mixed: Story = {
  args: { progress: ACTIVATION_PROGRESS_LIST_MIXED },
};

/**
 * The list before the daemon has answered. Placeholder rows stand in for the
 * real ones, because a row rendered against progress that has not landed would
 * offer a finished task back to the user.
 */
export const Loading: Story = {
  args: { progress: undefined },
};

/** The mixed list on a phone, where the file card has the least room. */
export const Light797MixedMobile: Story = {
  args: { progress: ACTIVATION_PROGRESS_LIST_MIXED },
  globals: { viewport: { value: "sbMobile" } },
};

/**
 * The mixed list in dark. The green check and its disc are the pair most
 * likely to collapse into each other once the positive tokens flip.
 */
export const Light797MixedDark: Story = {
  args: { progress: ACTIVATION_PROGRESS_LIST_MIXED },
  globals: { theme: "dark" },
};

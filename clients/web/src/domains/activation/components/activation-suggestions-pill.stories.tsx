/**
 * The minimized checklist (Figma: New-App `8300:167083`).
 *
 * Two things are worth protecting here. The mascot cluster has to hang off the
 * pill's left edge and be cut by the rounded corner rather than sitting inside
 * the padding; and at phone width the word "Suggestions" has to go while the
 * count stays, because the count is the part carrying information and the top
 * bar has a search control and a bell to seat beside it.
 *
 * `InTopBarCluster` is the one that answers "does it fit": the pill lands in
 * the chat layout's top-bar accessory next to the notification bell, and the
 * two must not crowd each other.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Bell } from "lucide-react";

import { Button } from "@vellumai/design-library";

import { ActivationSuggestionsPill } from "@/domains/activation/components/activation-suggestions-pill";

const meta: Meta<typeof ActivationSuggestionsPill> = {
  title: "Activation/ActivationSuggestionsPill",
  component: ActivationSuggestionsPill,
  parameters: { layout: "centered" },
  args: { done: 1, total: 3, onClick: () => {} },
};

export default meta;
type Story = StoryObj<typeof ActivationSuggestionsPill>;

/** One starter done, two to go: the state the pill spends most of its life in. */
export const Default: Story = {};

/** Nothing started yet, which is what a user who dismissed on sight sees. */
export const NothingDone: Story = {
  args: { done: 0 },
};

/** The pill on the dark ground, where the lifted surface is the only edge it has. */
export const Dark: Story = {
  globals: { theme: "dark" },
};

/**
 * Phone width, where the label drops out. The mascots and the count are what
 * remain, and the pill has to stay wide enough to be a comfortable tap target.
 */
export const Mobile: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

/** The narrowest phone the app runs on, which is where a stray word would wrap. */
export const NarrowPhone: Story = {
  globals: { viewport: { value: "sbNarrowPhone", isRotated: false } },
};

/**
 * The pill beside the notification bell, as `routes.tsx` composes them into the
 * chat layout's top-bar accessory.
 *
 * The bell is a stand-in, not the real `NotificationsBell`: that component
 * belongs to the home domain and the composition happens at the route, so
 * importing it here would trip the cross-domain import rule. It is the same
 * ghost icon-only `Button` with the same glyph, which is all this story needs
 * it to be.
 */
export const InTopBarCluster: Story = {
  parameters: { controls: { disable: true }, layout: "padded" },
  render: (args) => (
    <div className="flex items-center justify-end gap-2 border-b border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-2">
      <ActivationSuggestionsPill {...args} />
      <Button
        variant="ghost"
        iconOnlyGlyphClassName="[&_svg]:size-4.5 touch-mobile:[&_svg]:size-4.5"
        iconOnly={<Bell />}
        aria-label="Notifications"
      />
    </div>
  ),
};

/** The same cluster at phone width, where the two controls compete for the row. */
export const InTopBarClusterMobile: Story = {
  ...InTopBarCluster,
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

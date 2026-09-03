/**
 * The tinted circle leading a checklist row (Figma: New-App `8300:168065`).
 *
 * The gallery is the point: the seven accents have to read as one family and
 * every wash has to stay distinguishable from its neighbour in light, dark and
 * velvet. Flip the theme toolbar over `AllColors` to check that, and watch the
 * yellow and the green in particular, which are the two that lose the most
 * contrast against a dark ground.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Calendar, CalendarCheck, FileText, Share2 } from "lucide-react";

import { ACTIVATION_COLORS } from "@/domains/activation/catalog";
import { ActivationTaskIcon } from "@/domains/activation/components/activation-task-icon";

const meta: Meta<typeof ActivationTaskIcon> = {
  title: "Activation/ActivationTaskIcon",
  component: ActivationTaskIcon,
  parameters: { layout: "padded" },
  args: { icon: FileText, color: "blue", state: "todo" },
  argTypes: {
    color: { control: "select", options: [...ACTIVATION_COLORS] },
    state: { control: "inline-radio", options: ["todo", "done"] },
    icon: { control: false },
  },
};

export default meta;
type Story = StoryObj<typeof ActivationTaskIcon>;

/** One task's glyph on its own accent. */
export const Default: Story = {};

/** What a finished task swaps to: a check on the positive wash (PLAN A21). */
export const Done: Story = {
  args: { state: "done" },
};

/** Every accent the catalog can name, in catalog order. */
export const AllColors: Story = {
  parameters: { controls: { disable: true } },
  render: (args) => (
    <div className="flex items-center gap-3">
      {ACTIVATION_COLORS.map((color) => (
        <ActivationTaskIcon {...args} key={color} color={color} />
      ))}
    </div>
  ),
};

/** The same row of accents against the dark ground, where the washes thin out. */
export const AllColorsDark: Story = {
  ...AllColors,
  globals: { theme: "dark" },
};

/** The glyphs the three `smb` starters carry, beside the done treatment. */
export const StarterGlyphs: Story = {
  parameters: { controls: { disable: true } },
  render: (args) => (
    <div className="flex items-center gap-3">
      <ActivationTaskIcon {...args} icon={FileText} color="blue" />
      <ActivationTaskIcon {...args} icon={CalendarCheck} color="teal" />
      <ActivationTaskIcon {...args} icon={Share2} color="pink" />
      <ActivationTaskIcon {...args} icon={Calendar} color="teal" state="done" />
    </div>
  ),
};

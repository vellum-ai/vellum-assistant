/**
 * Visual reference for the group dialog's icon picker.
 *
 * The picker is a grid of icon-only `Button`s rather than sidebar rows: it is
 * a form control, so it sits on the Button scale, while the same group icons
 * on the collapsed rail are `SideMenu.Item`s on the sidebar's 30px one. The
 * two are deliberately not one component, and the grid is where that choice
 * is visible: tile size, how the row wraps, and whether a selection reads at
 * a glance.
 *
 * That last one is the thing to look at. A selected tile's `active` surface
 * is `--surface-lift`, which is the dialog's own background, so the ring is
 * what actually marks the selection.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";

import { NameInputDialog } from "@/domains/chat/components/name-input-dialog";

const meta: Meta<typeof NameInputDialog> = {
  title: "Chat/NameInputDialog",
  component: NameInputDialog,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    title: "Rename group",
    submitLabel: "Save",
    initialValue: "Research",
    // Both handlers are required props the dialog calls unconditionally, and
    // Storybook has no actions addon here to spy them in, so the defaults have
    // to be real no-ops: without `onSubmit` the confirm button throws as soon
    // as the name is non-empty and changed.
    onSubmit: () => {},
    onCancel: () => {},
  },
  argTypes: {
    open: { control: "boolean" },
    title: { control: "text" },
    submitLabel: { control: "text" },
    initialValue: { control: "text" },
    iconPicker: { control: false },
    onSubmit: { control: false },
    onCancel: { control: false },
  },
};

export default meta;
type Story = StoryObj<typeof NameInputDialog>;

/** The plain rename dialog, with no picker: the baseline the picker adds to. */
export const Default: Story = {};

/**
 * With the picker. `star` is pre-selected so the selected treatment is on
 * screen without having to hover or click for it.
 */
export const WithIconPicker: Story = {
  name: "With icon picker",
  args: { iconPicker: { initialIcon: "star" } },
  // Controlled by the dialog's own state, but the story drives `initialValue`
  // so typing in the canvas doesn't fight the Controls panel.
  render: function Render(args) {
    const [, updateArgs] = useArgs();
    return (
      <NameInputDialog
        {...args}
        onSubmit={(value, icon) => updateArgs({ initialValue: value, icon })}
      />
    );
  },
};

/** Creating a group: no icon chosen yet, so "No icon" carries the selection. */
export const NewGroupNoIconSelected: Story = {
  name: "New group · no icon selected",
  args: {
    title: "New group",
    submitLabel: "Create",
    initialValue: "",
    iconPicker: { initialIcon: null },
  },
};

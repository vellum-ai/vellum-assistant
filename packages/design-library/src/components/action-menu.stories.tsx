import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowUp, Ellipsis, Pin, Trash2 } from "lucide-react";
import { useState } from "react";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";

import { ActionMenu, type ActionMenuPresentation } from "./action-menu";
import { Button } from "./button";

interface ActionMenuStoryArgs {
  presentation?: ActionMenuPresentation;
  title: string;
  showTitle: boolean;
  disableDelete: boolean;
}

/**
 * One command list, two surfaces. Left unset, `presentation` resolves from
 * input capability: an anchored dropdown under a pointer, a bottom sheet under
 * a thumb. The stories pin it so both are reviewable on a desktop, which is the
 * only reason a caller would ever pass it.
 */
const meta: Meta<ActionMenuStoryArgs> = {
  title: "Components/ActionMenu",
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component: [
          "A list of commands hung off a trigger, rendered as the surface the",
          "current input deserves: an anchored dropdown under a pointer, a bottom",
          "sheet under a thumb.",
          "",
          "Items are declared once. Callers do not check the device, and do not",
          "close the surface themselves: selection closes it before the handler",
          "runs, so an action that opens a dialog does not fight the menu it came",
          "from.",
          "",
          "Use `Menu` directly for a menu with submenus, which has no settled",
          "sheet equivalent yet.",
        ].join("\n"),
      },
    },
  },
  args: {
    title: "Options for Notes",
    showTitle: false,
    disableDelete: false,
  },
  argTypes: {
    presentation: {
      control: "inline-radio",
      options: [undefined, "anchored", "sheet"],
    },
    title: { control: "text" },
    showTitle: { control: "boolean" },
    disableDelete: { control: "boolean" },
  },
  render: function RenderActionMenu({
    presentation,
    title,
    showTitle,
    disableDelete,
  }) {
    const [pinned, setPinned] = useState(false);
    return (
      <ActionMenu.Root presentation={presentation}>
        <ActionMenu.Trigger asChild>
          <Button variant="ghost" iconOnly={<Ellipsis />} aria-label={title} />
        </ActionMenu.Trigger>
        <ActionMenu.Content title={title} showTitle={showTitle}>
          <ActionMenu.Item
            icon={Pin}
            label={pinned ? "Unpin" : "Pin"}
            onSelect={() => setPinned((value) => !value)}
          />
          <ActionMenu.Item
            icon={ArrowUp}
            label="Share"
            description="Export as .vellum file"
          />
          <ActionMenu.Separator />
          <ActionMenu.Item
            icon={Trash2}
            label="Delete"
            tone="destructive"
            disabled={disableDelete}
          />
        </ActionMenu.Content>
      </ActionMenu.Root>
    );
  },
};

export default meta;
type Story = StoryObj<ActionMenuStoryArgs>;

/** Resolves from input capability, which on a desktop canvas is the dropdown. */
export const Default: Story = {};

export const Anchored: Story = {
  args: { presentation: "anchored" },
};

export const Sheet: Story = {
  args: { presentation: "sheet" },
};

/** A sheet whose title earns its place on screen rather than staying sr-only. */
export const SheetWithVisibleTitle: Story = {
  args: { presentation: "sheet", showTitle: true },
};

export const WithGroupLabel: Story = {
  args: { title: "Conversation actions" },
  parameters: { controls: { disable: true } },
  render: ({ title }) => (
    <ActionMenu.Root>
      <ActionMenu.Trigger asChild>
        <Button variant="outlined">Actions</Button>
      </ActionMenu.Trigger>
      <ActionMenu.Content title={title}>
        <ActionMenu.Label>This conversation</ActionMenu.Label>
        <ActionMenu.Item label="Rename" />
        <ActionMenu.Item label="Duplicate" shortcut="⌘D" />
        <ActionMenu.Separator />
        <ActionMenu.Label>Everything</ActionMenu.Label>
        <ActionMenu.Item label="Archive all" />
      </ActionMenu.Content>
    </ActionMenu.Root>
  ),
};

/**
 * Open state driven from outside, for a caller that already tracks it (a row
 * that reveals its trigger while the menu is open, say). The surface reports
 * its own dismissals back through `onOpenChange`.
 */
export const Controlled: Story = {
  args: { presentation: "anchored" },
  parameters: { controls: { disable: true } },
  render: function RenderControlled({ presentation, title }) {
    const [open, setOpen] = useState(false);
    return (
      <div className="flex flex-col items-center gap-3">
        <Button variant="outlined" onClick={() => setOpen(true)}>
          Open from outside
        </Button>
        <ActionMenu.Root
          presentation={presentation}
          open={open}
          onOpenChange={setOpen}
        >
          <ActionMenu.Trigger asChild>
            <Button
              variant="ghost"
              iconOnly={<Ellipsis />}
              aria-label={title}
            />
          </ActionMenu.Trigger>
          <ActionMenu.Content title={title}>
            <ActionMenu.Item icon={Pin} label="Pin" />
          </ActionMenu.Content>
        </ActionMenu.Root>
        <span>{open ? "Menu open" : "Menu closed"}</span>
      </div>
    );
  },
  play: async () => {
    await userEvent.click(
      await screen.findByRole("button", { name: "Open from outside" }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));

    // Selection reports the close upward rather than closing behind the
    // caller's back, so external state cannot desync from the surface.
    await waitFor(() => {
      expect(screen.getByText("Menu closed")).toBeVisible();
    });
  },
};

/**
 * The behaviour both surfaces owe their callers: the item runs, and the surface
 * closes without the caller arranging it. Asserted twice because a menu and the
 * sheet substituting for it only stay interchangeable if they agree here.
 */
function selectionClosesTheSurface(
  presentation: ActionMenuPresentation,
): Story {
  return {
    args: { presentation },
    play: async () => {
      const openMenu = async () => {
        await userEvent.click(
          await screen.findByRole("button", { name: "Options for Notes" }),
        );
      };
      // A sheet is a dialog of rows; an anchored surface is a menu of
      // menuitems. The roles differ because the presentations do, which is the
      // point of asserting the same behaviour through both.
      const surfaceRole = presentation === "sheet" ? "dialog" : "menu";
      const itemRole = presentation === "sheet" ? "button" : "menuitem";
      const openItems = async () =>
        within(await screen.findByRole(surfaceRole));

      await openMenu();
      await userEvent.click(
        await (await openItems()).findByRole(itemRole, { name: "Pin" }),
      );

      // Closed: the surface itself is gone, not merely emptied.
      await waitFor(() => {
        expect(screen.queryByRole(surfaceRole)).toBeNull();
      });

      // Ran: the row reflects the state the handler set. Retried, because the
      // sheet enters from `opacity: 0` and is briefly not visible on arrival.
      await openMenu();
      await waitFor(async () => {
        expect(
          await (await openItems()).findByRole(itemRole, { name: "Unpin" }),
        ).toBeVisible();
      });
    },
  };
}

export const AnchoredSelection: Story = {
  ...selectionClosesTheSurface("anchored"),
};

export const SheetSelection: Story = {
  ...selectionClosesTheSurface("sheet"),
};

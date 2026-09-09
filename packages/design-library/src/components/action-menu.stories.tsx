import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowUp, Ellipsis, Link2, Pin, Trash2 } from "lucide-react";
import { useState } from "react";
import { useArgs } from "storybook/preview-api";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";

import {
  ActionMenu,
  type ActionMenuPresentation,
  type ActionMenuRootProps,
} from "./action-menu";
import { Button } from "./button";

/**
 * Every `Root` prop is an arg, so a prop added to the component reaches Controls
 * without a story edit. `children` is the command list a story composes, which
 * is not something to type into a control.
 */
type ActionMenuStoryArgs = Omit<ActionMenuRootProps, "children"> & {
  title: string;
  showTitle: boolean;
  disableDelete: boolean;
};

/** The args `Root` owns, apart from the ones the surrounding markup reads. */
function rootArgs({
  title: _title,
  showTitle: _showTitle,
  disableDelete: _disableDelete,
  ...root
}: ActionMenuStoryArgs): Omit<ActionMenuRootProps, "children"> {
  return root;
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
    open: { control: "boolean" },
    defaultOpen: { control: "boolean" },
    onOpenChange: { control: false },
    title: { control: "text" },
    showTitle: { control: "boolean" },
    disableDelete: { control: "boolean" },
  },
  render: function RenderActionMenu(args) {
    const { title, showTitle, disableDelete } = args;
    const [pinned, setPinned] = useState(false);
    return (
      <ActionMenu.Root {...rootArgs(args)}>
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
  render: (args) => (
    <ActionMenu.Root {...rootArgs(args)}>
      <ActionMenu.Trigger asChild>
        <Button variant="outlined">Actions</Button>
      </ActionMenu.Trigger>
      <ActionMenu.Content title={args.title}>
        <ActionMenu.Label>This conversation</ActionMenu.Label>
        <ActionMenu.Item label="Rename" />
        <ActionMenu.Item label="Duplicate" shortcut="CmdOrCtrl+D" />
        <ActionMenu.Separator />
        <ActionMenu.Label>Everything</ActionMenu.Label>
        <ActionMenu.Item label="Archive all" />
      </ActionMenu.Content>
    </ActionMenu.Root>
  ),
};

/**
 * `shortcut` takes the accelerator and draws it, announcing the same binding
 * through `aria-keyshortcuts`. Both slots belong to the pointer surface only:
 * flip `presentation` to `sheet` and the rows keep their labels and lose the
 * right column, since a thumb has no keys and the sheet row has no trailing
 * slot.
 */
export const WithTrailingContent: Story = {
  args: { title: "Deployment", presentation: "anchored" },
  render: (args) => (
    <ActionMenu.Root {...rootArgs(args)}>
      <ActionMenu.Trigger asChild>
        <Button variant="outlined">Deployment</Button>
      </ActionMenu.Trigger>
      <ActionMenu.Content title={args.title}>
        <ActionMenu.Item
          icon={Pin}
          label="Pin conversation"
          shortcut="CmdOrCtrl+Shift+P"
        />
        <ActionMenu.Item icon={Link2} label="Deployed" trailing="Copy link" />
        <ActionMenu.Item icon={ArrowUp} label="Share" />
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
  args: { presentation: "anchored", open: false },
  render: function RenderControlled(args) {
    const [{ open }, updateArgs] = useArgs<ActionMenuStoryArgs>();
    return (
      <div className="flex flex-col items-center gap-3">
        <Button variant="outlined" onClick={() => updateArgs({ open: true })}>
          Open from outside
        </Button>
        <ActionMenu.Root
          {...rootArgs(args)}
          open={open}
          onOpenChange={(next) => updateArgs({ open: next })}
        >
          <ActionMenu.Trigger asChild>
            <Button
              variant="ghost"
              iconOnly={<Ellipsis />}
              aria-label={args.title}
            />
          </ActionMenu.Trigger>
          <ActionMenu.Content title={args.title}>
            <ActionMenu.Item icon={Pin} label="Pin" />
          </ActionMenu.Content>
        </ActionMenu.Root>
        <span>{open ? "Menu open" : "Menu closed"}</span>
      </div>
    );
  },
};

/**
 * A controlled caller is told about a dismissal once, though the item and the
 * surface each ask for the close, so a caller counting dismissals to reveal its
 * trigger is not told twice about one of them.
 *
 * Open state is local rather than an arg here: `updateArgs` reaches the canvas
 * through the preview channel, which the story runner does not turn, so an
 * args-backed story cannot assert its own state transitions. `Controlled` above
 * is the args-backed one, and this covers the behaviour a control cannot show.
 */
export const ControlledReportsOneClose: Story = {
  args: { presentation: "anchored" },
  parameters: { controls: { disable: true } },
  render: function RenderReportsOneClose(args) {
    const [open, setOpen] = useState(false);
    const [closes, setCloses] = useState(0);
    return (
      <div className="flex flex-col items-center gap-3">
        <Button variant="outlined" onClick={() => setOpen(true)}>
          Open from outside
        </Button>
        <ActionMenu.Root
          {...rootArgs(args)}
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) {
              setCloses((count) => count + 1);
            }
          }}
        >
          <ActionMenu.Trigger asChild>
            <Button
              variant="ghost"
              iconOnly={<Ellipsis />}
              aria-label={args.title}
            />
          </ActionMenu.Trigger>
          <ActionMenu.Content title={args.title}>
            <ActionMenu.Item icon={Pin} label="Pin" />
          </ActionMenu.Content>
        </ActionMenu.Root>
        <span>{open ? "Menu open" : "Menu closed"}</span>
        <span>Closes reported: {closes}</span>
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

    expect(screen.getByText("Closes reported: 1")).toBeVisible();
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

import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { Check, ChevronRight, Circle } from "lucide-react";
import { type ComponentProps, type ReactNode } from "react";

import { cn } from "../utils/cn";
import { menuContentBase, menuItemBase } from "../utils/menu-styles";
import { usePortalContainer } from "../utils/portal-container";

/**
 * `ContextMenu` is a right-click / long-press menu primitive built on
 * `@radix-ui/react-context-menu`. It mirrors the visual conventions of `Menu`
 * so a context-menu and an action-menu against the same target render
 * identically — same surface, typography, hover token, and animation.
 *
 * Use `ContextMenu` when the trigger is a region (e.g. a row, a card, a
 * canvas) rather than a button. The trigger captures `contextmenu` events
 * (right-click on desktop, long-press on touch) and Radix positions the
 * floating menu at the pointer.
 *
 * The exported compound-component shape deliberately matches `Menu`, so a
 * single render helper can produce items for both.
 *
 * @see https://www.radix-ui.com/primitives/docs/components/context-menu
 */

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

const Root = ContextMenuPrimitive.Root;

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

type TriggerProps = ComponentProps<typeof ContextMenuPrimitive.Trigger>;

function Trigger({ asChild = true, ...props }: TriggerProps) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      asChild={asChild}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

type ContentProps = ComponentProps<typeof ContextMenuPrimitive.Content>;

function Content({
  className,
  collisionPadding = 8,
  ref,
  ...rest
}: ContentProps) {
  const container = usePortalContainer();
  return (
    <ContextMenuPrimitive.Portal container={container ?? undefined}>
      <ContextMenuPrimitive.Content
        ref={ref}
        data-slot="context-menu-content"
        collisionPadding={collisionPadding}
        className={cn(menuContentBase, className)}
        {...rest}
      />
    </ContextMenuPrimitive.Portal>
  );
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

type ItemProps = ComponentProps<typeof ContextMenuPrimitive.Item> & {
  readonly leftIcon?: ReactNode;
  readonly shortcut?: ReactNode;
};

function Item({
  className,
  children,
  leftIcon,
  shortcut,
  ref,
  ...rest
}: ItemProps) {
  return (
    <ContextMenuPrimitive.Item
      ref={ref}
      data-slot="context-menu-item"
      className={cn(menuItemBase, className)}
      {...rest}
    >
      {leftIcon ? (
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--content-tertiary)]"
          aria-hidden
        >
          {leftIcon}
        </span>
      ) : null}
      <span className="flex-1 truncate">{children}</span>
      {shortcut ? (
        <span className="ml-auto pl-4 text-body-small-default tracking-wide text-[var(--content-tertiary)]">
          {shortcut}
        </span>
      ) : null}
    </ContextMenuPrimitive.Item>
  );
}

// ---------------------------------------------------------------------------
// CheckboxItem
// ---------------------------------------------------------------------------

type CheckboxItemProps = ComponentProps<
  typeof ContextMenuPrimitive.CheckboxItem
> & {
  readonly shortcut?: ReactNode;
};

function CheckboxItem({
  className,
  children,
  checked,
  shortcut,
  ref,
  ...rest
}: CheckboxItemProps) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      ref={ref}
      checked={checked}
      data-slot="context-menu-checkbox-item"
      className={cn(menuItemBase, "pl-7", className)}
      {...rest}
    >
      <span className="absolute left-1.5 flex h-4 w-4 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>
          <Check
            className="h-3.5 w-3.5 text-[var(--content-default)]"
            aria-hidden
          />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      <span className="flex-1 truncate">{children}</span>
      {shortcut ? (
        <span className="ml-auto pl-4 text-body-small-default tracking-wide text-[var(--content-tertiary)]">
          {shortcut}
        </span>
      ) : null}
    </ContextMenuPrimitive.CheckboxItem>
  );
}

// ---------------------------------------------------------------------------
// RadioGroup / RadioItem
// ---------------------------------------------------------------------------

type RadioGroupProps = ComponentProps<typeof ContextMenuPrimitive.RadioGroup>;

function RadioGroup({ ref, ...rest }: RadioGroupProps) {
  return (
    <ContextMenuPrimitive.RadioGroup
      ref={ref}
      data-slot="context-menu-radio-group"
      {...rest}
    />
  );
}

type RadioItemProps = ComponentProps<
  typeof ContextMenuPrimitive.RadioItem
> & {
  readonly shortcut?: ReactNode;
};

function RadioItem({
  className,
  children,
  shortcut,
  ref,
  ...rest
}: RadioItemProps) {
  return (
    <ContextMenuPrimitive.RadioItem
      ref={ref}
      data-slot="context-menu-radio-item"
      className={cn(menuItemBase, "pl-7", className)}
      {...rest}
    >
      <span className="absolute left-1.5 flex h-4 w-4 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>
          <Circle
            className="h-2 w-2 fill-current text-[var(--content-default)]"
            aria-hidden
          />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      <span className="flex-1 truncate">{children}</span>
      {shortcut ? (
        <span className="ml-auto pl-4 text-body-small-default tracking-wide text-[var(--content-tertiary)]">
          {shortcut}
        </span>
      ) : null}
    </ContextMenuPrimitive.RadioItem>
  );
}

// ---------------------------------------------------------------------------
// Separator
// ---------------------------------------------------------------------------

type SeparatorProps = ComponentProps<typeof ContextMenuPrimitive.Separator>;

function Separator({ className, ref, ...rest }: SeparatorProps) {
  return (
    <ContextMenuPrimitive.Separator
      ref={ref}
      data-slot="context-menu-separator"
      className={cn("my-1 h-px bg-[var(--border-base)]", className)}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Label
// ---------------------------------------------------------------------------

type LabelProps = ComponentProps<typeof ContextMenuPrimitive.Label>;

function Label({ className, ref, ...rest }: LabelProps) {
  return (
    <ContextMenuPrimitive.Label
      ref={ref}
      data-slot="context-menu-label"
      className={cn(
        "px-2 py-1.5 text-body-small-default uppercase tracking-wide",
        "text-[var(--content-tertiary)]",
        className,
      )}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Sub / SubTrigger / SubContent
// ---------------------------------------------------------------------------

const Sub = ContextMenuPrimitive.Sub;

type SubTriggerProps = ComponentProps<
  typeof ContextMenuPrimitive.SubTrigger
> & {
  readonly leftIcon?: ReactNode;
};

function SubTrigger({
  className,
  children,
  leftIcon,
  ref,
  ...rest
}: SubTriggerProps) {
  return (
    <ContextMenuPrimitive.SubTrigger
      ref={ref}
      data-slot="context-menu-sub-trigger"
      className={cn(
        menuItemBase,
        "data-[state=open]:bg-[var(--surface-hover)]",
        "data-[state=open]:text-[var(--content-emphasised)]",
        className,
      )}
      {...rest}
    >
      {leftIcon ? (
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--content-tertiary)]"
          aria-hidden
        >
          {leftIcon}
        </span>
      ) : null}
      <span className="flex-1 truncate">{children}</span>
      <ChevronRight
        className="ml-auto h-3.5 w-3.5 text-[var(--content-tertiary)]"
        aria-hidden
      />
    </ContextMenuPrimitive.SubTrigger>
  );
}

type SubContentProps = ComponentProps<
  typeof ContextMenuPrimitive.SubContent
>;

function SubContent({ className, ref, ...rest }: SubContentProps) {
  const container = usePortalContainer();
  return (
    <ContextMenuPrimitive.Portal container={container ?? undefined}>
      <ContextMenuPrimitive.SubContent
        ref={ref}
        data-slot="context-menu-sub-content"
        className={cn(menuContentBase, className)}
        {...rest}
      />
    </ContextMenuPrimitive.Portal>
  );
}

// ---------------------------------------------------------------------------
// Compound export
// ---------------------------------------------------------------------------

const ContextMenu = {
  Root,
  Trigger,
  Content,
  Item,
  CheckboxItem,
  RadioGroup,
  RadioItem,
  Separator,
  Label,
  Sub,
  SubTrigger,
  SubContent,
};

export {
  ContextMenu,
  type ContentProps as ContextMenuContentProps,
  type ItemProps as ContextMenuItemProps,
  type CheckboxItemProps as ContextMenuCheckboxItemProps,
  type RadioGroupProps as ContextMenuRadioGroupProps,
  type RadioItemProps as ContextMenuRadioItemProps,
  type SeparatorProps as ContextMenuSeparatorProps,
  type LabelProps as ContextMenuLabelProps,
  type SubTriggerProps as ContextMenuSubTriggerProps,
  type SubContentProps as ContextMenuSubContentProps,
  type TriggerProps as ContextMenuTriggerProps,
};

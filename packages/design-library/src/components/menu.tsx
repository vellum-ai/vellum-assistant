import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Circle } from "lucide-react";
import { type ComponentProps, type ReactNode, useRef } from "react";

import { cn } from "../utils/cn";
import { menuContentBase, menuItemBase } from "../utils/menu-styles";
import { usePortalContainer } from "../utils/portal-container";

/**
 * `Menu` is a command / action menu primitive built on
 * `@radix-ui/react-dropdown-menu`. It renders a floating list of actions
 * triggered by a button — think application menu, context menu, or overflow
 * menu.
 *
 * This is distinct from `Dropdown` which is a single-value form selector.
 * Use `Menu` for command lists, multi-level submenus, checkbox toggles, and
 * radio groups.
 *
 * All floating content is portaled into the element provided by the nearest
 * `<PortalContainerProvider>` so design tokens (CSS variables) resolve
 * correctly inside the portal. Falls back to `document.body` when no
 * provider is mounted.
 *
 * @see https://www.radix-ui.com/primitives/docs/components/dropdown-menu
 */

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

const Root = DropdownMenuPrimitive.Root;

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

type TriggerProps = ComponentProps<typeof DropdownMenuPrimitive.Trigger>;

function Trigger({ asChild = true, ...props }: TriggerProps) {
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="menu-trigger"
      asChild={asChild}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

type ContentProps = ComponentProps<typeof DropdownMenuPrimitive.Content>;

function Content({
  className,
  sideOffset = 6,
  collisionPadding = 8,
  onPointerDownOutside,
  onCloseAutoFocus,
  ref,
  ...rest
}: ContentProps) {
  const container = usePortalContainer();
  const closedByPointerRef = useRef(false);

  const handlePointerDownOutside: ContentProps["onPointerDownOutside"] = (e) => {
    closedByPointerRef.current = true;
    onPointerDownOutside?.(e);
  };

  const handleCloseAutoFocus: ContentProps["onCloseAutoFocus"] = (e) => {
    if (closedByPointerRef.current) {
      e.preventDefault();
      closedByPointerRef.current = false;
    }
    onCloseAutoFocus?.(e);
  };

  return (
    <DropdownMenuPrimitive.Portal container={container ?? undefined}>
      <DropdownMenuPrimitive.Content
        ref={ref}
        data-slot="menu-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        onPointerDownOutside={handlePointerDownOutside}
        onCloseAutoFocus={handleCloseAutoFocus}
        className={cn(menuContentBase, className)}
        {...rest}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

type ItemProps = ComponentProps<typeof DropdownMenuPrimitive.Item> & {
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
    <DropdownMenuPrimitive.Item
      ref={ref}
      data-slot="menu-item"
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
    </DropdownMenuPrimitive.Item>
  );
}

// ---------------------------------------------------------------------------
// CheckboxItem
// ---------------------------------------------------------------------------

type CheckboxItemProps = ComponentProps<
  typeof DropdownMenuPrimitive.CheckboxItem
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
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      checked={checked}
      data-slot="menu-checkbox-item"
      className={cn(menuItemBase, "pl-7", className)}
      {...rest}
    >
      <span className="absolute left-1.5 flex h-4 w-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check
            className="h-3.5 w-3.5 text-[var(--content-default)]"
            aria-hidden
          />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      <span className="flex-1 truncate">{children}</span>
      {shortcut ? (
        <span className="ml-auto pl-4 text-body-small-default tracking-wide text-[var(--content-tertiary)]">
          {shortcut}
        </span>
      ) : null}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

// ---------------------------------------------------------------------------
// RadioGroup / RadioItem
// ---------------------------------------------------------------------------

type RadioGroupProps = ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>;

function RadioGroup({ ref, ...rest }: RadioGroupProps) {
  return (
    <DropdownMenuPrimitive.RadioGroup
      ref={ref}
      data-slot="menu-radio-group"
      {...rest}
    />
  );
}

type RadioItemProps = ComponentProps<
  typeof DropdownMenuPrimitive.RadioItem
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
    <DropdownMenuPrimitive.RadioItem
      ref={ref}
      data-slot="menu-radio-item"
      className={cn(menuItemBase, "pl-7", className)}
      {...rest}
    >
      <span className="absolute left-1.5 flex h-4 w-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Circle
            className="h-2 w-2 fill-current text-[var(--content-default)]"
            aria-hidden
          />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      <span className="flex-1 truncate">{children}</span>
      {shortcut ? (
        <span className="ml-auto pl-4 text-body-small-default tracking-wide text-[var(--content-tertiary)]">
          {shortcut}
        </span>
      ) : null}
    </DropdownMenuPrimitive.RadioItem>
  );
}

// ---------------------------------------------------------------------------
// Separator
// ---------------------------------------------------------------------------

type SeparatorProps = ComponentProps<typeof DropdownMenuPrimitive.Separator>;

function Separator({ className, ref, ...rest }: SeparatorProps) {
  return (
    <DropdownMenuPrimitive.Separator
      ref={ref}
      data-slot="menu-separator"
      className={cn("my-1 h-px bg-[var(--border-base)]", className)}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Label
// ---------------------------------------------------------------------------

type LabelProps = ComponentProps<typeof DropdownMenuPrimitive.Label>;

function Label({ className, ref, ...rest }: LabelProps) {
  return (
    <DropdownMenuPrimitive.Label
      ref={ref}
      data-slot="menu-label"
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

const Sub = DropdownMenuPrimitive.Sub;

type SubTriggerProps = ComponentProps<
  typeof DropdownMenuPrimitive.SubTrigger
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
    <DropdownMenuPrimitive.SubTrigger
      ref={ref}
      data-slot="menu-sub-trigger"
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
    </DropdownMenuPrimitive.SubTrigger>
  );
}

type SubContentProps = ComponentProps<
  typeof DropdownMenuPrimitive.SubContent
>;

function SubContent({ className, ref, ...rest }: SubContentProps) {
  const container = usePortalContainer();
  return (
    <DropdownMenuPrimitive.Portal container={container ?? undefined}>
      <DropdownMenuPrimitive.SubContent
        ref={ref}
        data-slot="menu-sub-content"
        className={cn(menuContentBase, className)}
        {...rest}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

// ---------------------------------------------------------------------------
// Compound export
// ---------------------------------------------------------------------------

const Menu = {
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
  Menu,
  type ContentProps as MenuContentProps,
  type ItemProps as MenuItemProps,
  type CheckboxItemProps as MenuCheckboxItemProps,
  type RadioGroupProps as MenuRadioGroupProps,
  type RadioItemProps as MenuRadioItemProps,
  type SeparatorProps as MenuSeparatorProps,
  type LabelProps as MenuLabelProps,
  type SubTriggerProps as MenuSubTriggerProps,
  type SubContentProps as MenuSubContentProps,
  type TriggerProps as MenuTriggerProps,
};

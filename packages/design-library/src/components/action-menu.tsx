import { type LucideIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { cn } from "../utils/cn";
import { useTouchSurface } from "../utils/touch-surface";

import { BottomSheet } from "./bottom-sheet";
import { Menu } from "./menu";
import { PanelItem } from "./panel-item/panel-item";

/**
 * `ActionMenu` is a list of commands hung off a trigger, rendered as the
 * surface the current input deserves: an anchored dropdown under a pointer, a
 * bottom sheet under a thumb.
 *
 * Callers describe the commands once and never ask what device they are on.
 * That is the point: a menu and the sheet that substitutes for it are one
 * decision with one right answer, so the primitive owns it. Declaring the
 * items twice (once as `Menu.Item`, once as sheet rows) is how the two copies
 * drift, and they do: focus handling, height caps, and close-on-select land in
 * one branch and not the other.
 *
 * ```tsx
 * <ActionMenu.Root>
 *   <ActionMenu.Trigger asChild>
 *     <Button iconOnly={<Ellipsis />} aria-label="Options for Notes" />
 *   </ActionMenu.Trigger>
 *   <ActionMenu.Content title="Options for Notes" align="end">
 *     <ActionMenu.Item icon={Pin} label="Pin" onSelect={pin} />
 *     <ActionMenu.Item icon={Trash2} label="Delete" onSelect={remove} />
 *   </ActionMenu.Content>
 * </ActionMenu.Root>
 * ```
 *
 * Selection closes the menu, in both presentations, before the handler runs, so
 * an action that opens a dialog does not fight the surface it was launched
 * from.
 *
 * Submenus are not part of this API. A menu with nested branches has no
 * settled sheet equivalent (a sheet either flattens them or pushes a second
 * level), so those callers keep `Menu` and `BottomSheet` directly until the
 * nested case is designed.
 *
 * Each part renders the underlying primitive's own `data-slot`
 * (`menu-item`, `bottom-sheet-content`, and so on), so CSS written against
 * `Menu` or `BottomSheet` keeps applying here.
 *
 * @see https://www.radix-ui.com/primitives/docs/components/dropdown-menu
 * @see https://m3.material.io/components/bottom-sheets/guidelines
 * @see https://developer.apple.com/design/human-interface-guidelines/sheets
 */

type ActionMenuPresentation = "anchored" | "sheet";

interface ActionMenuContextValue {
  presentation: ActionMenuPresentation;
  close: () => void;
}

const ActionMenuContext = createContext<ActionMenuContextValue | null>(null);

function useActionMenuContext(part: string): ActionMenuContextValue {
  const context = useContext(ActionMenuContext);
  if (!context) {
    throw new Error(
      `ActionMenu.${part} must be rendered inside ActionMenu.Root`,
    );
  }
  return context;
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

interface ActionMenuRootProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Pin the surface instead of resolving it from input capability. Reach for
   * this only when the menu is part of a surface that is already committed to
   * one form (a sheet demonstrated in a story, a menu inside a sheet); a
   * caller passing its own device check here is the fork this component
   * exists to remove.
   */
  presentation?: ActionMenuPresentation;
  children: ReactNode;
}

function Root({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  presentation: presentationProp,
  children,
}: ActionMenuRootProps) {
  const isTouchSurface = useTouchSurface();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);

  const open = openProp ?? uncontrolledOpen;
  const presentation =
    presentationProp ?? (isTouchSurface ? "sheet" : "anchored");

  // Selecting an item closes the surface, and the anchored surface also closes
  // itself, so the same transition arrives twice. The latch reports it once.
  const reported = useRef(open);
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (openProp === undefined) {
        setUncontrolledOpen(next);
      }
      if (reported.current === next) {
        return;
      }
      reported.current = next;
      onOpenChange?.(next);
    },
    [onOpenChange, openProp],
  );

  useEffect(() => {
    reported.current = open;
  }, [open]);

  const close = useCallback(() => handleOpenChange(false), [handleOpenChange]);

  const Surface = presentation === "sheet" ? BottomSheet.Root : Menu.Root;

  return (
    <ActionMenuContext value={{ presentation, close }}>
      <Surface open={open} onOpenChange={handleOpenChange}>
        {children}
      </Surface>
    </ActionMenuContext>
  );
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

type ActionMenuTriggerProps = ComponentProps<typeof BottomSheet.Trigger>;

function Trigger({ asChild = true, ...props }: ActionMenuTriggerProps) {
  const { presentation } = useActionMenuContext("Trigger");
  return presentation === "sheet" ? (
    <BottomSheet.Trigger asChild={asChild} {...props} />
  ) : (
    <Menu.Trigger asChild={asChild} {...props} />
  );
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

interface ActionMenuContentProps {
  /**
   * The menu's accessible name, e.g. "Options for Notes". A sheet is a dialog
   * and needs one; an anchored menu carries it as `aria-label` so both
   * presentations announce the same thing.
   */
  title: string;
  /** Render {@link title} as a visible heading. Sheets only. */
  showTitle?: boolean;
  children: ReactNode;
  className?: string;
  /** Anchored positioning. Ignored by the sheet, which spans the bottom edge. */
  side?: ComponentProps<typeof Menu.Content>["side"];
  align?: ComponentProps<typeof Menu.Content>["align"];
  sideOffset?: number;
}

function Content({
  title,
  showTitle = false,
  children,
  className,
  side,
  align = "end",
  sideOffset = 4,
}: ActionMenuContentProps) {
  const { presentation } = useActionMenuContext("Content");

  if (presentation === "sheet") {
    return (
      <BottomSheet.Content aria-describedby={undefined} className={className}>
        <BottomSheet.Header className={showTitle ? undefined : "sr-only"}>
          <BottomSheet.Title>{title}</BottomSheet.Title>
        </BottomSheet.Header>
        <BottomSheet.Body className={showTitle ? undefined : "pt-0"}>
          {children}
        </BottomSheet.Body>
      </BottomSheet.Content>
    );
  }

  return (
    <Menu.Content
      aria-label={title}
      side={side}
      align={align}
      sideOffset={sideOffset}
      className={className}
    >
      {children}
    </Menu.Content>
  );
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

interface ActionMenuItemProps {
  icon?: LucideIcon;
  label: ReactNode;
  /**
   * Supporting line for the label, rendered where there is room for it (the
   * sheet). An anchored menu row stays single-line, so this must clarify the
   * label rather than carry anything the label omits.
   */
  description?: ReactNode;
  /**
   * Electron accelerator for the row's binding, e.g. `"CmdOrCtrl+Shift+P"`.
   * Draws the glyph hint and announces the binding from the one value. Pointer
   * surfaces only, since a sheet has no keys.
   */
  shortcut?: string;
  /**
   * Right-aligned trailing content that is not a keyboard shortcut: a status
   * glyph, secondary hint text. Anchored presentation only; the sheet row has
   * no trailing column.
   */
  trailing?: ReactNode;
  /**
   * `"destructive"` paints the row in the negative system colour, for an action
   * that deletes or discards. A tone rather than a caller-supplied class, so
   * the warning looks the same in both presentations: a menu row styled red and
   * a sheet row left default is the drift this component exists to prevent.
   */
  tone?: "default" | "destructive";
  disabled?: boolean;
  onSelect?: () => void;
  className?: string;
}

/**
 * Classes that paint a destructive row, per presentation. One place, because a
 * tone that reads as dangerous in one surface and ordinary in the other is the
 * drift this component exists to prevent, and because each surface hands its
 * glyph the row's colour rather than a second colour of its own: a highlighted
 * or pressed row moves label and icon together.
 */
export const actionMenuDestructiveClasses: Record<
  ActionMenuPresentation,
  string
> = {
  anchored:
    "text-[var(--system-negative-strong)] data-[highlighted]:text-[var(--system-negative-hover)] [&_[data-slot=menu-item-icon]]:text-inherit",
  sheet:
    "text-[var(--system-negative-strong)] [--panel-item-icon-fg:var(--system-negative-strong)]",
};

function Item({
  icon: Icon,
  label,
  description,
  shortcut,
  trailing,
  tone = "default",
  disabled = false,
  onSelect,
  className,
}: ActionMenuItemProps) {
  const { presentation, close } = useActionMenuContext("Item");
  const isDestructive = tone === "destructive";

  if (presentation === "sheet") {
    return (
      <PanelItem
        icon={Icon}
        label={
          description ? (
            <span className="flex flex-col gap-0.5 overflow-visible whitespace-normal">
              <span>{label}</span>
              <span className="text-body-small-default text-[var(--content-tertiary)]">
                {description}
              </span>
            </span>
          ) : (
            label
          )
        }
        // The command names the row, so a supporting line does not become part
        // of its accessible name and both presentations announce the same verb.
        aria-label={typeof label === "string" ? label : undefined}
        disabled={disabled}
        className={cn(
          isDestructive && actionMenuDestructiveClasses.sheet,
          className,
        )}
        onSelect={() => {
          close();
          onSelect?.();
        }}
      />
    );
  }

  return (
    <Menu.Item
      leftIcon={Icon ? <Icon size={14} /> : undefined}
      shortcut={shortcut}
      trailing={trailing}
      disabled={disabled}
      className={cn(
        "whitespace-nowrap",
        isDestructive && actionMenuDestructiveClasses.anchored,
        className,
      )}
      onSelect={() => {
        close();
        onSelect?.();
      }}
    >
      {label}
    </Menu.Item>
  );
}

// ---------------------------------------------------------------------------
// Separator
// ---------------------------------------------------------------------------

function Separator({ className }: { className?: string }) {
  const { presentation } = useActionMenuContext("Separator");

  if (presentation === "sheet") {
    return (
      <div
        data-slot="action-menu-separator"
        role="separator"
        className={cn("my-1 h-px bg-[var(--border-base)]", className)}
      />
    );
  }

  return <Menu.Separator className={className} />;
}

// ---------------------------------------------------------------------------
// Label
// ---------------------------------------------------------------------------

function Label({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const { presentation } = useActionMenuContext("Label");

  if (presentation === "sheet") {
    return (
      <div
        data-slot="action-menu-label"
        className={cn(
          "px-2 pt-2 pb-1 text-body-small-default uppercase tracking-wide text-[var(--content-tertiary)]",
          className,
        )}
      >
        {children}
      </div>
    );
  }

  return <Menu.Label className={className}>{children}</Menu.Label>;
}

const ActionMenu = {
  Root,
  Trigger,
  Content,
  Item,
  Separator,
  Label,
};

export { ActionMenu };
export type {
  ActionMenuPresentation,
  ActionMenuRootProps,
  ActionMenuTriggerProps,
  ActionMenuContentProps,
  ActionMenuItemProps,
};

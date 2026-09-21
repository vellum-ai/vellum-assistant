import { cva, type VariantProps } from "class-variance-authority";
import { Check } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
} from "react";

import { cn } from "../utils/cn";
import { mergeRefs } from "../utils/merge-refs";
import { CARD_SELECTED_CLASSES } from "./card";

export type OptionCardSelectionMode = "single" | "multiple";

interface OptionCardGroupContextValue {
  selectionMode: OptionCardSelectionMode;
  disabled: boolean;
}

const OptionCardGroupContext =
  createContext<OptionCardGroupContextValue | null>(null);

const OPTION_CARD_SELECTOR = '[data-slot="option-card"]';

/**
 * Root chrome of an `OptionCard`.
 *
 * - `outlined` is the bordered tile: `Card`'s interactive hover and pressed
 *   fills, and `Card`'s selected border and tint.
 * - `filled` is the borderless row for a surface that is already a step down
 *   the ladder (a chat transcript): it reads as a row by its fill alone, so
 *   selection is carried by the border and the mark and the fill stays put.
 */
const optionCardVariants = cva(
  [
    "group/option-card flex w-full cursor-pointer rounded-lg border p-3 text-left",
    "text-[color:var(--content-default)]",
    "outline-none transition-colors",
    "keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:ring-offset-0",
    "disabled:cursor-not-allowed disabled:opacity-60",
  ].join(" "),
  {
    variants: {
      variant: {
        outlined: "",
        filled: [
          "bg-[var(--surface-overlay)]",
          "enabled:hover:bg-[var(--surface-active)]",
          "enabled:active:bg-[color-mix(in_srgb,var(--content-default)_8%,var(--surface-active))]",
        ].join(" "),
      },
      orientation: {
        horizontal: "flex-row items-center gap-3",
        vertical: "flex-col items-stretch gap-1.5",
      },
      selected: {
        true: "",
        false: "",
      },
    },
    compoundVariants: [
      {
        variant: "outlined",
        selected: false,
        class: [
          "border-[var(--border-element)] bg-[var(--surface-lift)]",
          "enabled:hover:bg-[var(--surface-base)]",
          "enabled:active:bg-[var(--surface-active)]",
        ].join(" "),
      },
      { variant: "outlined", selected: true, class: CARD_SELECTED_CLASSES },
      { variant: "filled", selected: false, class: "border-transparent" },
      {
        variant: "filled",
        selected: true,
        class: "border-[var(--primary-base)]",
      },
    ],
    defaultVariants: {
      variant: "outlined",
      orientation: "horizontal",
      selected: false,
    },
  },
);

type OptionCardSize = "regular" | "compact";

const TITLE_CLASSES: Record<OptionCardSize, string> = {
  regular: "text-body-medium-default",
  compact: "text-body-small-default",
};

const DESCRIPTION_CLASSES: Record<OptionCardSize, string> = {
  regular: "mt-0.5 text-body-small-default",
  compact: "mt-1 text-label-small-default",
};

/**
 * The selection mark. Presentational twins of the library's form controls so
 * a tile and a bare control read as the same thing:
 * - `single` is `Radio`'s 16px ring with an 8px dot, honoring the same
 *   `--radio-checked-bg` / `--radio-checked-dot` override hooks.
 * - `multiple` is `Checkbox`'s 16px box with a 12px stroke-3 check.
 * The tile's own `role` and `aria-checked` carry the state, so the mark is
 * hidden from assistive tech.
 */
function OptionCardMark({
  selectionMode,
  selected,
}: {
  selectionMode: OptionCardSelectionMode;
  selected: boolean;
}) {
  if (selectionMode === "single") {
    return (
      <span
        aria-hidden="true"
        data-slot="option-card-mark"
        data-mark="radio"
        className={cn(
          "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
          selected
            ? "border-transparent bg-[var(--radio-checked-bg,var(--system-positive-strong))]"
            : "border-[color:var(--border-element)]",
        )}
      >
        {selected ? (
          <span className="block h-2 w-2 rounded-full bg-[var(--radio-checked-dot,var(--aux-white))]" />
        ) : null}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-slot="option-card-mark"
      data-mark="checkbox"
      className={cn(
        "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border-2 transition-colors",
        selected
          ? "border-transparent bg-[var(--primary-active)]"
          : "border-[var(--content-tertiary)] bg-[var(--field-bg)]",
      )}
    >
      {selected ? (
        <Check
          className="h-3 w-3 text-[color:var(--content-inset)]"
          strokeWidth={3}
        />
      ) : null}
    </span>
  );
}

export interface OptionCardProps
  extends Omit<ComponentProps<"button">, "title" | "onSelect" | "children">,
    Omit<VariantProps<typeof optionCardVariants>, "selected"> {
  /** Whether this option is currently chosen. Controlled by the caller. */
  selected: boolean;
  /**
   * Fired on click, Space and Enter. A caller `onClick` runs first and can
   * veto it with `event.preventDefault()`, as on `SideMenuItem`.
   */
  onSelect?: () => void;
  /**
   * `single` is a radio (`role="radio"`, radio mark); `multiple` is a checkbox
   * (`role="checkbox"`, check mark). Defaults to the enclosing
   * `OptionCardGroup`'s mode, or `single` outside one.
   */
  selectionMode?: OptionCardSelectionMode;
  title: ReactNode;
  description?: ReactNode;
  /** Icon slot. Inherits `--content-secondary`. */
  leading?: ReactNode;
  /** Trailing slot, for example a spinner or a badge. */
  trailing?: ReactNode;
  /** Which end the mark sits at. `start` suits rows, `end` suits tiles. */
  markPosition?: "start" | "end";
  /** Drops the mark; the border and `aria-checked` still carry selection. */
  hideMark?: boolean;
  /** `compact` steps the type down a size for narrow grid tiles. */
  size?: OptionCardSize;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * A selectable tile: a real `<button>` that announces itself as a radio or a
 * checkbox and draws the matching mark. Selection is controlled (`selected` +
 * `onSelect`). Wrap a set in `OptionCardGroup` for the group role, the grid,
 * and (single mode) arrow-key navigation.
 *
 * Everything inside the button is a `<span>`: a button's content model is
 * phrasing content, so pass phrasing content to the slots too.
 */
function OptionCard({
  selected,
  onSelect,
  selectionMode: selectionModeProp,
  title,
  description,
  leading,
  trailing,
  markPosition = "start",
  hideMark = false,
  variant = "outlined",
  orientation = "horizontal",
  size = "regular",
  disabled: disabledProp = false,
  className,
  onClick,
  ref,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: OptionCardProps) {
  const group = useContext(OptionCardGroupContext);
  const selectionMode = selectionModeProp ?? group?.selectionMode ?? "single";
  const disabled = disabledProp || group?.disabled === true;
  const reactId = useId();
  const titleId = `${reactId}-title`;
  const descriptionId = `${reactId}-description`;

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (!event.defaultPrevented) {
      onSelect?.();
    }
  };

  const mark = hideMark ? null : (
    <OptionCardMark selectionMode={selectionMode} selected={selected} />
  );
  const leadingNode =
    leading != null ? (
      <span
        data-slot="option-card-leading"
        className="flex h-5 min-w-5 shrink-0 items-center justify-center text-[color:var(--content-secondary)]"
      >
        {leading}
      </span>
    ) : null;
  const trailingNode =
    trailing != null ? (
      <span
        data-slot="option-card-trailing"
        className="flex shrink-0 items-center"
      >
        {trailing}
      </span>
    ) : null;
  const content = (
    <span data-slot="option-card-content" className="block min-w-0 flex-1">
      <span
        id={titleId}
        data-slot="option-card-title"
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1",
          TITLE_CLASSES[size],
        )}
      >
        {title}
      </span>
      {description != null ? (
        <span
          id={descriptionId}
          data-slot="option-card-description"
          className={cn(
            "block text-[color:var(--content-tertiary)]",
            DESCRIPTION_CLASSES[size],
          )}
        >
          {description}
        </span>
      ) : null}
    </span>
  );
  const startMark = markPosition === "start" ? mark : null;
  const endMark = markPosition === "end" ? mark : null;

  return (
    <button
      // In a single-select group the checked card is the tab stop. The group
      // hands the stop to the first enabled card when nothing is checked.
      tabIndex={
        group && selectionMode === "single" ? (selected ? 0 : -1) : undefined
      }
      {...rest}
      ref={ref}
      type="button"
      role={selectionMode === "single" ? "radio" : "checkbox"}
      aria-checked={selected}
      aria-label={ariaLabel}
      aria-labelledby={
        ariaLabelledBy ?? (ariaLabel === undefined ? titleId : undefined)
      }
      aria-describedby={
        ariaDescribedBy ?? (description != null ? descriptionId : undefined)
      }
      disabled={disabled}
      data-slot="option-card"
      data-selected={selected ? "" : undefined}
      onClick={handleClick}
      className={cn(
        optionCardVariants({ variant, orientation, selected }),
        className,
      )}
    >
      {orientation === "vertical" ? (
        <>
          <span className="flex w-full items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              {startMark}
              {leadingNode}
            </span>
            <span className="flex items-center gap-2">
              {trailingNode}
              {endMark}
            </span>
          </span>
          {content}
        </>
      ) : (
        <>
          {startMark}
          {leadingNode}
          {content}
          {trailingNode}
          {endMark}
        </>
      )}
    </button>
  );
}

export interface OptionCardGroupProps
  extends Omit<ComponentProps<"div">, "role"> {
  /** Shared by every `OptionCard` inside, so callers do not repeat it. */
  selectionMode?: OptionCardSelectionMode;
  /** Grid columns. Two columns also equalise the row heights. */
  columns?: 1 | 2;
  /**
   * Single mode only. Arrow keys move focus and, by default, select the card
   * they land on, which is the WAI-ARIA radio contract. Pass `false` when
   * selecting commits (submits, navigates, advances a wizard): an arrow key
   * would otherwise carry a keyboard user off the page before they reach the
   * third option. Arrows then only move focus and Space or Enter selects.
   */
  selectOnFocus?: boolean;
  /** Disables every card in the group. */
  disabled?: boolean;
  children?: ReactNode;
}

const NEXT_KEYS = new Set(["ArrowDown", "ArrowRight"]);
const PREVIOUS_KEYS = new Set(["ArrowUp", "ArrowLeft"]);

function enabledCards(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    root.querySelectorAll<HTMLButtonElement>(OPTION_CARD_SELECTOR),
  ).filter((card) => !card.disabled);
}

/**
 * Groups `OptionCard`s: `role="radiogroup"` (single) or `role="group"`
 * (multiple), a one or two column grid, and the selection mode through
 * context. Name it with `aria-label` or `aria-labelledby`.
 *
 * Single mode follows the WAI-ARIA radio group pattern: one tab stop (the
 * checked card, else the first enabled one) and wrapping arrow-key navigation.
 * In multiple mode every card is its own tab stop, as checkboxes are.
 */
function OptionCardGroup({
  selectionMode = "single",
  columns = 1,
  selectOnFocus = true,
  disabled = false,
  className,
  children,
  onKeyDown,
  ref,
  ...rest
}: OptionCardGroupProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const setRoot = useMemo(() => mergeRefs(rootRef, ref), [ref]);
  const context = useMemo(
    () => ({ selectionMode, disabled }),
    [selectionMode, disabled],
  );
  const single = selectionMode === "single";

  // Cards render their own tab stop from `selected`, which leaves no stop at
  // all while nothing is checked (or the checked card is disabled). Runs after
  // every render because only the DOM knows the cards' order.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !single) {
      return;
    }
    const cards = enabledCards(root);
    const stop =
      cards.find((card) => card.getAttribute("aria-checked") === "true") ??
      cards[0];
    for (const card of cards) {
      const next = card === stop ? 0 : -1;
      if (card.tabIndex !== next) {
        card.tabIndex = next;
      }
    }
  });

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || !single) {
      return;
    }
    const step = NEXT_KEYS.has(event.key)
      ? 1
      : PREVIOUS_KEYS.has(event.key)
        ? -1
        : 0;
    const root = rootRef.current;
    if (step === 0 || !root || !(event.target instanceof Element)) {
      return;
    }
    const current = event.target.closest(OPTION_CARD_SELECTOR);
    const cards = enabledCards(root);
    const index = cards.findIndex((card) => card === current);
    if (index === -1) {
      return;
    }
    event.preventDefault();
    const target = cards[(index + step + cards.length) % cards.length];
    target.focus();
    if (selectOnFocus && target.getAttribute("aria-checked") !== "true") {
      target.click();
    }
  };

  return (
    <OptionCardGroupContext value={context}>
      <div
        {...rest}
        ref={setRoot}
        role={single ? "radiogroup" : "group"}
        aria-disabled={disabled || undefined}
        data-slot="option-card-group"
        onKeyDown={handleKeyDown}
        className={cn(
          "grid gap-2",
          columns === 2 ? "auto-rows-fr grid-cols-2" : "grid-cols-1",
          className,
        )}
      >
        {children}
      </div>
    </OptionCardGroupContext>
  );
}

export { OptionCard, OptionCardGroup, optionCardVariants };

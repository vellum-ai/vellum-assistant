import { Check, ChevronDown } from "lucide-react";
import { useId, type CSSProperties, type ReactNode } from "react";
import * as RadixSelect from "@radix-ui/react-select";

import { Field, fieldDescriptionId } from "./field";
import { cn } from "../utils/cn";
import { usePortalContainer } from "../utils/portal-container";
import { Tooltip } from "./tooltip";

export type SelectMenuAlign = "start" | "end";

export type SelectSize = "regular" | "compact";

/**
 * `"ghost"` shrink-wraps the trigger and drops its border and fill until the
 * pointer or keyboard focus reaches it.
 *
 * Use it where the control sits in a run of read-only values (a detail panel's
 * fact list, say) and a permanently drawn box would make the one editable row
 * the heaviest thing on the surface. The chevron still marks it editable at
 * rest, so the affordance survives the missing border.
 */
export type SelectVariant = "default" | "ghost";

export interface SelectOption<T extends string> {
  /**
   * `null` marks the row meaning "no value chosen", where that is a real
   * choice rather than the absence of one. Selecting it calls
   * {@link SelectProps.onSelectNone} instead of `onChange`.
   *
   * Must not be the empty string: Radix reserves it to mean "cleared". For a
   * trigger that shows nothing until the user picks, use `placeholder`.
   */
  readonly value: T | null;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly suffix?: ReactNode;
  /**
   * Hover/focus tooltip describing the option, anchored to its right. Only
   * shows while the menu is open.
   */
  readonly tooltip?: ReactNode;
  /** Renders dimmed and cannot be chosen by click, keyboard, or typeahead. */
  readonly disabled?: boolean;
}

export interface SelectProps<T extends string> {
  readonly options: ReadonlyArray<SelectOption<T>>;
  /** Empty string means "nothing chosen", which renders `placeholder`. */
  /** `null` selects the option carrying a `null` value, if one is offered. */
  readonly value: T | "" | null;
  readonly onChange: (value: T) => void;
  /**
   * Called instead of `onChange` when the user picks the row whose value is
   * `null`. Separate so `onChange` keeps promising a narrowed `T`.
   */
  readonly onSelectNone?: () => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /** Trigger + option density. Defaults to `"regular"` (36px trigger). */
  readonly size?: SelectSize;
  /** Trigger chrome. Defaults to `"default"` (border and fill always drawn). */
  readonly variant?: SelectVariant;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly id?: string;
  readonly name?: string;
  /** Preferred height cap. Reduced automatically when the viewport is shorter. */
  readonly menuMaxHeight?: number;
  readonly menuMinWidth?: number;
  readonly menuAlign?: SelectMenuAlign;
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
  readonly "aria-describedby"?: string;
  readonly "data-testid"?: string;
  /** Field label rendered above the trigger and wired to it. */
  readonly label?: ReactNode;
  /** Guidance below the trigger. Suppressed while `errorText` is set. */
  readonly helperText?: ReactNode;
  /**
   * Blocking message below the trigger. Also tints the trigger border and
   * marks it `aria-invalid`, matching `Input`.
   */
  readonly errorText?: ReactNode;
  /** Stretch the field to its container. Defaults to true. */
  readonly fullWidth?: boolean;
  readonly wrapperClassName?: string;
}

const DEFAULT_MENU_MAX_HEIGHT = 280;

const TRIGGER_SIZE_CLASSES: Record<SelectSize, string> = {
  regular: "h-9 px-3 text-body-medium-lighter",
  compact: "h-7 px-2.5 text-body-small-default",
};

const OPTION_SIZE_CLASSES: Record<SelectSize, string> = {
  regular: "px-3 py-2 text-body-medium-default",
  compact: "px-2.5 py-1.5 text-body-small-default",
};

const CHEVRON_SIZE_CLASSES: Record<SelectSize, string> = {
  regular: "h-3.5 w-3.5",
  compact: "h-3 w-3",
};

/**
 * Ghost triggers set padding but no height, so a row of them keeps whatever
 * rhythm its container already has. A fixed height here would reintroduce the
 * problem the variant exists to solve: one row standing taller than its
 * read-only neighbours.
 */
const GHOST_TRIGGER_SIZE_CLASSES: Record<SelectSize, string> = {
  regular: "px-2 py-1 text-body-medium-lighter",
  compact: "px-1.5 py-0.5 text-body-small-default",
};

/**
 * Single-select control for choosing one value from a list.
 *
 * Use this when the user is picking a *value* that then shows in the trigger.
 * For a list of *actions* (Rename, Duplicate, Delete), use `Menu` instead:
 * that is a different control with different semantics, even though both
 * visually "drop down".
 *
 * Generic over `T extends string` so callers can narrow selection to a union
 * of literal values (e.g. `"managed" | "your-own"`) and get a typed `onChange`.
 *
 * Built on Radix Select, which owns everything that is easy to get subtly
 * wrong: portaling, Floating-UI placement with collision handling, focus
 * management, dismissal, roving selection, and typeahead. Two behaviours worth
 * knowing, both of which a hand-rolled positioner has to solve and usually
 * does not:
 *
 * - The menu portals out of the trigger's subtree, so an ancestor with a
 *   `transform`, `filter`, or `will-change` cannot capture it. Such an
 *   ancestor becomes the containing block for fixed-position descendants and
 *   would otherwise shift the menu by that ancestor's origin, typically clear
 *   off-screen, which reads to users as "the dropdown won't open".
 * - Placement flips and shifts to stay on screen, so a trigger near the bottom
 *   of the viewport opens upward instead of below the fold.
 *
 * @see Menu for action menus
 */
export function Select<T extends string>({
  options,
  value,
  onChange,
  placeholder,
  disabled = false,
  size = "regular",
  variant = "default",
  className,
  style,
  id,
  name,
  menuMaxHeight = DEFAULT_MENU_MAX_HEIGHT,
  menuMinWidth = 0,
  menuAlign = "start",
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  onSelectNone,
  "data-testid": dataTestId,
  label,
  helperText,
  errorText,
  fullWidth = true,
  wrapperClassName,
}: SelectProps<T>) {
  const portalContainer = usePortalContainer();
  const ghost = variant === "ghost";
  const reactId = useId();
  const triggerId = id ?? `select-${reactId}`;
  const invalid = Boolean(errorText);
  const describedBy =
    ariaDescribedBy ??
    fieldDescriptionId(triggerId, invalid, Boolean(helperText));

  // Radix throws if an item claims the empty string. Drop such options rather
  // than take the tree down, and say why: the intent is almost always a
  // leading "choose one" row, which is what `placeholder` is for.
  const selectableOptions = options.filter((option) => {
    if (option.value !== "") {
      return true;
    }
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.error(
        `Select: ignoring the option labelled "${option.label}" because an ` +
          `empty-string value is reserved. Use the \`placeholder\` prop for a ` +
          `"nothing chosen" row, or give the option a real sentinel value.`,
      );
    }
    return false;
  });

  // Radix addresses items by string, so the null row needs one. Derived from
  // the values actually present rather than fixed, so no real value can ever
  // be mistaken for it and nothing has to be reserved outside this file.
  const noneToken = (() => {
    const taken = new Set<string>(
      selectableOptions.flatMap((option) =>
        option.value === null ? [] : [option.value],
      ),
    );
    let token = "\u0000none";
    while (taken.has(token)) {
      token += "\u0000";
    }
    return token;
  })();

  const tokenFor = (optionValue: T | null): string =>
    optionValue === null ? noneToken : optionValue;

  const selectedOption = selectableOptions.find(
    (option) => option.value === value,
  );

  const control = (
    <RadixSelect.Root
      // Passed through untouched, empty string included. Radix reads
      // `prop !== undefined` as "controlled", so translating "" to `undefined`
      // would hand control back to Radix the moment a caller cleared the
      // value, leaving the trigger showing a stale choice. Radix already
      // treats "" as the placeholder state.
      value={value === null ? noneToken : value}
      // Radix hands back a plain `string`, but `onChange` promises callers a
      // narrowed `T`. Look the value up in `selectableOptions` and forward the
      // matched option's own `value`, so the type is earned at the runtime
      // boundary rather than asserted across it.
      onValueChange={(next) => {
        const matched = selectableOptions.find(
          (option) => tokenFor(option.value) === next,
        );
        if (!matched) {
          // Radix only emits values belonging to mounted items, so this is
          // unreachable in practice. Staying silent rather than forwarding an
          // unvalidated string keeps the callback's contract honest.
          if (process.env.NODE_ENV !== "production") {
            // eslint-disable-next-line no-console
            console.error(
              `Select: ignoring a change to "${next}", which matches no option.`,
            );
          }
          return;
        }
        if (matched.value === null) {
          onSelectNone?.();
          return;
        }
        onChange(matched.value);
      }}
      disabled={disabled}
      name={name}
    >
      <div
        data-slot="select"
        // A ghost trigger sizes to its content, so the wrapper goes inline to
        // shrink-wrap with it. Left block, it would stretch to the container
        // and strand the trigger on the left of a right-aligned row.
        className={cn("relative", ghost && "inline-flex", className)}
        style={style}
      >
        <RadixSelect.Trigger
          id={triggerId}
          aria-label={ariaLabel}
          aria-labelledby={
            ariaLabelledBy ?? (label ? `${triggerId}-label` : undefined)
          }
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          // Radix sets the native `disabled` attribute and `data-disabled`,
          // but not `aria-disabled`.
          aria-disabled={disabled || undefined}
          data-testid={dataTestId}
          data-slot="select-trigger"
          className={cn(
            "flex items-center gap-2 rounded-md border text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
            // Ghost draws its own focus ring as an outline, so suppressing the
            // UA outline here would erase it.
            ghost || "focus:outline-none",
            ghost
              ? "w-auto bg-transparent hover:bg-[var(--field-bg)] data-[state=open]:bg-[var(--field-bg)]"
              : "w-full bg-[var(--field-bg)]",
            invalid
              ? "border-[var(--system-negative-strong)] data-[state=open]:border-[var(--system-negative-strong)]"
              : ghost
                ? // The ring is withheld until the control is aimed at, so at
                  // rest the row reads as one of the values around it. Drawn
                  // as an outline rather than a border because outlines sit
                  // outside layout: the trigger keeps the height of a bare
                  // line of text, so its row matches its read-only
                  // neighbours and nothing shifts when the ring appears.
                  "border-0 outline outline-1 -outline-offset-1 outline-transparent hover:outline-[var(--field-border)] focus-visible:outline-[var(--field-border)] data-[state=open]:outline-[var(--border-active)]"
                : "border-[var(--field-border)] data-[state=open]:border-[var(--border-active)]",
            ghost ? GHOST_TRIGGER_SIZE_CLASSES[size] : TRIGGER_SIZE_CLASSES[size],
          )}
          style={{
            color: selectedOption
              ? "var(--content-default)"
              : "var(--content-tertiary)",
          }}
        >
          {selectedOption?.icon && (
            <span
              className="flex shrink-0 items-center"
              style={{ color: "var(--content-tertiary)" }}
              aria-hidden
            >
              {selectedOption.icon}
            </span>
          )}
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className="min-w-0 flex-1 truncate"
              title={selectedOption?.label || undefined}
            >
              {/* Explicit children rather than Radix's default, which reads
                    from the mounted item and so renders nothing before the menu
                    has opened or under `renderToStaticMarkup`. Falling back to
                    the placeholder keeps a value that no longer matches any
                    option (a deleted profile, say) from rendering as a blank
                    control. */}
              <RadixSelect.Value placeholder={placeholder ?? ""}>
                {selectedOption?.label ?? placeholder ?? ""}
              </RadixSelect.Value>
            </span>
            {selectedOption?.suffix && (
              <span className="shrink-0">{selectedOption.suffix}</span>
            )}
          </span>
          <RadixSelect.Icon asChild>
            <ChevronDown
              className={cn("shrink-0", CHEVRON_SIZE_CLASSES[size])}
              style={{ color: "var(--content-tertiary)" }}
              aria-hidden
            />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
      </div>

      <RadixSelect.Portal container={portalContainer ?? undefined}>
        <RadixSelect.Content
          position="popper"
          side="bottom"
          align={menuAlign}
          sideOffset={4}
          collisionPadding={8}
          data-slot="select-menu"
          className="pointer-events-auto z-50 overflow-hidden rounded-md border border-[var(--field-border)] bg-[var(--field-bg)] shadow-xl focus:outline-none"
          style={{
            // Derived from the boxes Radix measures: the trigger's width, and
            // the space actually left after collision handling. `maxWidth`
            // matters as much as `minWidth`, since without an upper bound the
            // popper sizes to its content and the per-row `truncate` never
            // engages, so long labels widen the menu instead of clipping.
            minWidth: `max(var(--radix-select-trigger-width), ${menuMinWidth}px)`,
            maxWidth: "var(--radix-select-content-available-width)",
            maxHeight: `min(${menuMaxHeight}px, var(--radix-select-content-available-height))`,
          }}
        >
          <RadixSelect.Viewport className="py-1">
            {selectableOptions.map((option) => {
              const optionRow = (
                <RadixSelect.Item
                  key={tokenFor(option.value)}
                  value={tokenFor(option.value)}
                  disabled={option.disabled}
                  data-slot="select-option"
                  className={cn(
                    "flex items-center gap-2 outline-none transition-colors",
                    OPTION_SIZE_CLASSES[size],
                    option.disabled
                      ? "cursor-not-allowed opacity-50"
                      : "cursor-pointer data-[highlighted]:bg-[var(--surface-hover)]",
                  )}
                  style={{ color: "var(--content-default)" }}
                >
                  {option.icon && (
                    <span
                      className="flex shrink-0 items-center"
                      style={{ color: "var(--content-tertiary)" }}
                      aria-hidden
                    >
                      {option.icon}
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <RadixSelect.ItemText>
                      <span
                        className="min-w-0 flex-1 truncate"
                        // Skip the native title when a styled tooltip is
                        // present: it would surface a second, redundant
                        // browser tooltip repeating the label.
                        title={
                          option.tooltip ? undefined : option.label || undefined
                        }
                      >
                        {option.label}
                      </span>
                    </RadixSelect.ItemText>
                    {option.suffix && (
                      <span className="shrink-0">{option.suffix}</span>
                    )}
                  </span>
                  <RadixSelect.ItemIndicator asChild>
                    <Check
                      className="h-3.5 w-3.5 shrink-0"
                      style={{ color: "var(--system-positive-strong)" }}
                      aria-hidden
                    />
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              );
              return option.tooltip ? (
                <Tooltip
                  key={tokenFor(option.value)}
                  content={option.tooltip}
                  side="right"
                >
                  {optionRow}
                </Tooltip>
              ) : (
                optionRow
              );
            })}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );

  // Nothing to label or explain: stay a bare control so existing call
  // sites that position the trigger themselves are unaffected.
  if (label == null && helperText == null && errorText == null) {
    return control;
  }

  return (
    <Field
      id={triggerId}
      label={label}
      helperText={helperText}
      errorText={errorText}
      fullWidth={fullWidth}
      disabled={disabled}
      className={wrapperClassName}
    >
      {control}
    </Field>
  );
}

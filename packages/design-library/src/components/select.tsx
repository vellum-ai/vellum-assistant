import { Check, ChevronDown } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import * as RadixSelect from "@radix-ui/react-select";

import { cn } from "../utils/cn";
import { usePortalContainer } from "../utils/portal-container";
import { Tooltip } from "./tooltip";

export type SelectMenuAlign = "start" | "end";

export type SelectSize = "regular" | "compact";

export interface SelectOption<T extends string> {
  /**
   * Must not be the empty string: Radix reserves it to mean "cleared". For a
   * leading "nothing chosen" row, use `placeholder`; for a row that means
   * something specific ("Default", "Custom"), give it a real sentinel value.
   */
  readonly value: T;
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
  readonly value: T | "";
  readonly onChange: (value: T) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /** Trigger + option density. Defaults to `"regular"` (36px trigger). */
  readonly size?: SelectSize;
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
  readonly "data-testid"?: string;
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
  className,
  style,
  id,
  name,
  menuMaxHeight = DEFAULT_MENU_MAX_HEIGHT,
  menuMinWidth = 0,
  menuAlign = "start",
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "data-testid": dataTestId,
}: SelectProps<T>) {
  const portalContainer = usePortalContainer();

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

  const selectedOption = selectableOptions.find(
    (option) => option.value === value,
  );

  return (
    <RadixSelect.Root
      // Passed through untouched, empty string included. Radix reads
      // `prop !== undefined` as "controlled", so translating "" to `undefined`
      // would hand control back to Radix the moment a caller cleared the
      // value, leaving the trigger showing a stale choice. Radix already
      // treats "" as the placeholder state.
      value={value}
      // Radix hands back a plain `string`, but `onChange` promises callers a
      // narrowed `T`. Look the value up in `selectableOptions` and forward the
      // matched option's own `value`, so the type is earned at the runtime
      // boundary rather than asserted across it.
      onValueChange={(next) => {
        const matched = selectableOptions.find(
          (option) => option.value === next,
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
        onChange(matched.value);
      }}
      disabled={disabled}
      name={name}
    >
      <div data-slot="select" className={cn("relative", className)} style={style}>
        <RadixSelect.Trigger
          id={id}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          // Radix sets the native `disabled` attribute and `data-disabled`,
          // but not `aria-disabled`.
          aria-disabled={disabled || undefined}
          data-testid={dataTestId}
          data-slot="select-trigger"
          className={cn(
            "flex w-full items-center gap-2 rounded-md border border-[var(--field-border)] bg-[var(--field-bg)] text-left transition-colors focus:outline-none data-[state=open]:border-[var(--border-active)] disabled:cursor-not-allowed disabled:opacity-60",
            TRIGGER_SIZE_CLASSES[size],
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
                  key={option.value}
                  value={option.value}
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
                  key={option.value}
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
}

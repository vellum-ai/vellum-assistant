import { Check, ChevronDown } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import * as RadixSelect from "@radix-ui/react-select";

import { cn } from "../utils/cn";
import { usePortalContainer } from "../utils/portal-container";
import { Tooltip } from "./tooltip";

export type DropdownMenuAlign = "start" | "end";

export type DropdownSize = "regular" | "compact";

export interface DropdownOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly suffix?: ReactNode;
  /**
   * Optional hover/focus tooltip describing the option. When present, the
   * option row is wrapped in a styled `Tooltip` (anchored to its right) so the
   * meaning is discoverable without selecting. Only shows while the menu is open.
   */
  readonly tooltip?: ReactNode;
  /**
   * When true, the option renders dimmed and cannot be selected by click,
   * keyboard, or typeahead. The option still occupies a row so the list reads
   * consistently. Defaults to selectable.
   */
  readonly disabled?: boolean;
}

export interface DropdownProps<T extends string> {
  readonly options: ReadonlyArray<DropdownOption<T>>;
  /** Empty string means "nothing selected", which renders `placeholder`. */
  readonly value: T | "";
  readonly onChange: (value: T) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /** Trigger + option density. Defaults to `"regular"` (36px trigger). */
  readonly size?: DropdownSize;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly id?: string;
  readonly name?: string;
  readonly menuMaxHeight?: number;
  readonly menuMinWidth?: number;
  readonly menuAlign?: DropdownMenuAlign;
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
  readonly "data-testid"?: string;
}

const TRIGGER_SIZE_CLASSES: Record<DropdownSize, string> = {
  regular: "h-9 px-3 text-body-medium-lighter",
  compact: "h-7 px-2.5 text-body-small-default",
};

const OPTION_SIZE_CLASSES: Record<DropdownSize, string> = {
  regular: "px-3 py-2 text-body-medium-default",
  compact: "px-2.5 py-1.5 text-body-small-default",
};

const CHEVRON_SIZE_CLASSES: Record<DropdownSize, string> = {
  regular: "h-3.5 w-3.5",
  compact: "h-3 w-3",
};

/**
 * Single-select dropdown for choosing a text item.
 *
 * Generic over `T extends string` so callers can narrow selection to a union
 * of literal values (e.g. `"managed" | "your-own"`) and get a typed
 * `onChange` callback. Visuals follow semantic tokens (`--surface-lift`,
 * `--border-base`, etc.).
 *
 * Built on Radix Select, like every other overlay in this package. Radix owns
 * the parts that are easy to get subtly wrong and that this component used to
 * hand-roll: portaling, Floating-UI placement with collision handling, focus
 * management, dismissal, roving selection, and typeahead. Two consequences
 * worth knowing:
 *
 * - The menu portals out of the trigger's subtree, so an ancestor with a
 *   `transform` (which would otherwise become the containing block for the
 *   fixed-position menu and push it off-screen) cannot displace it.
 * - Placement flips and shifts to stay on screen, so a trigger near the
 *   bottom of the viewport opens upward rather than below the fold.
 *
 * `value=""` means "nothing selected". Radix reserves the empty string for
 * clearing, so it is mapped to an undefined Radix value and never handed to
 * an item; a caller that wants an explicit "none" row should give it a real
 * sentinel value, or use `placeholder` instead.
 */
export function Dropdown<T extends string>({
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
  menuMaxHeight = 280,
  menuMinWidth = 0,
  menuAlign = "start",
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "data-testid": dataTestId,
}: DropdownProps<T>) {
  const portalContainer = usePortalContainer();

  // Radix reserves the empty string to mean "cleared" and throws if an item
  // claims it. Drop such options rather than take the whole tree down, and say
  // why: the intent is almost always a leading "choose one" row, which is what
  // `placeholder` is for.
  const selectableOptions = options.filter((option) => {
    if (option.value !== "") {
      return true;
    }
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.error(
        `Dropdown: ignoring the option labelled "${option.label}" because an ` +
          `empty-string value is reserved. Use the \`placeholder\` prop for a ` +
          `"nothing selected" row, or give the option a real sentinel value.`,
      );
    }
    return false;
  });

  const selectedOption = selectableOptions.find(
    (option) => option.value === value,
  );

  return (
    <RadixSelect.Root
      value={value === "" ? undefined : value}
      onValueChange={(next) => onChange(next as T)}
      disabled={disabled}
      name={name}
    >
      <div data-slot="dropdown" className={className} style={style}>
        <RadixSelect.Trigger
          id={id}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          data-testid={dataTestId}
          data-slot="dropdown-trigger"
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
              {/* Children rather than Radix's default rendering. Radix derives
                  the default from the mounted item, which does not exist until
                  the menu opens, so the trigger would render empty on first
                  paint and under `renderToStaticMarkup`. */}
              <RadixSelect.Value placeholder={placeholder ?? ""}>
                {selectedOption?.label}
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
          data-slot="dropdown-menu"
          className="pointer-events-auto z-50 overflow-hidden rounded-md border border-[var(--field-border)] bg-[var(--field-bg)] shadow-xl focus:outline-none"
          style={{
            // Radix publishes the measured trigger box and the space actually
            // available after collision handling. Deriving from those keeps
            // the menu trigger-width by default and stops `menuMaxHeight`
            // from overflowing a short viewport.
            minWidth: `max(var(--radix-select-trigger-width), ${menuMinWidth}px)`,
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
                  data-slot="dropdown-option"
                  className={cn(
                    "flex items-center gap-2 transition-colors outline-none",
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
                        // present: it would surface a second, redundant browser
                        // tooltip repeating the label. Truncation recovery
                        // still applies otherwise.
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
                <Tooltip key={option.value} content={option.tooltip} side="right">
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

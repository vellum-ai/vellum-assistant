import { ChevronDown } from "lucide-react";
import {
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Combobox } from "./combobox";
import { Field, fieldDescriptionId } from "./field";
import { Popover } from "./popover";
import { cn } from "../utils/cn";

export interface SearchableSelectOption {
  /** Identity of the option, and what `onChange` reports. Must be unique. */
  readonly value: string;
  /** What the row shows, and what the query is matched against. */
  readonly label: string;
  /** Right-aligned annotation on the row (a provider chip, a hint). */
  readonly suffix?: ReactNode;
  /**
   * Held out of the filter and pinned to the bottom edge of the list, for the
   * row that leaves the list rather than continuing it ("Enter a custom
   * id…"). In a list long enough to scroll, an unpinned last row is the one
   * nobody finds.
   */
  readonly sticky?: boolean;
}

export interface SearchableSelectProps {
  readonly options: readonly SearchableSelectOption[];
  /** The chosen option's value; the empty string means nothing is chosen. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Shown in the empty field, and while nothing is chosen. */
  readonly placeholder?: string;
  /** Rendered inside the list when the query matches nothing. */
  readonly emptyText: ReactNode;
  readonly disabled?: boolean;
  readonly id?: string;
  /** Field label rendered above the control and wired to it. */
  readonly label?: ReactNode;
  /** Guidance below the control. Suppressed while `errorText` is set. */
  readonly helperText?: ReactNode;
  /** Blocking message below the control; also marks it `aria-invalid`. */
  readonly errorText?: ReactNode;
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
  /** Preferred height cap on the list, in pixels. */
  readonly menuMaxHeight?: number;
  readonly className?: string;
  /**
   * What the live region says when the number of matches changes. Narrowing
   * a list is a silent event on screen, so the count is announced; pass a
   * translated builder.
   */
  readonly announceResults?: (count: number) => string;
}

const DEFAULT_MENU_MAX_HEIGHT = 280;

/**
 * A `Select` whose list is filtered by typing: the trigger is the search
 * field, so the whole interaction is one control and one Tab stop.
 *
 * Reach for it over `Select` once the option list outgrows what a person can
 * scan, which for a dropdown is somewhere around a dozen rows. Below that,
 * `Select` is the simpler control and a search field is furniture.
 *
 * It is a composition of two primitives this package already owns rather than
 * a third dropdown implementation: `Combobox` supplies the keyboard and ARIA
 * contract of the [combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
 * (focus never leaves the field, the highlight moves through
 * `aria-activedescendant`, the match count is announced), and `Popover`
 * supplies the portal. The portal is the reason the two are composed here
 * instead of at each call site: an in-flow list is clipped by the first
 * scrolling ancestor, and this control's natural homes (a modal body, a
 * settings sidepanel) are exactly that.
 *
 * Escape is handled on the field and stopped there, so it closes the list
 * without also closing the dialog the field sits in. Once the list is closed
 * it passes through, and the dialog closes on the second press.
 */
export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder,
  emptyText,
  disabled = false,
  id,
  label,
  helperText,
  errorText,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  menuMaxHeight = DEFAULT_MENU_MAX_HEIGHT,
  className,
  announceResults,
}: SearchableSelectProps) {
  const reactId = useId();
  const fieldId = id ?? `searchable-select-${reactId}`;
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // `null` while the field is showing the current selection rather than a
  // query. Distinct from `""`, which is a query the user has cleared and so
  // still means "show me everything".
  const [query, setQuery] = useState<string | null>(null);

  const selectedOption = options.find((option) => option.value === value);
  const trimmedQuery = (query ?? "").trim().toLowerCase();

  const { visibleOptions, stickyOptions } = useMemo(() => {
    const sticky = options.filter((option) => option.sticky);
    const matchable = options.filter((option) => !option.sticky);
    const matches =
      trimmedQuery === ""
        ? matchable
        : matchable.filter(
            (option) =>
              option.label.toLowerCase().includes(trimmedQuery) ||
              option.value.toLowerCase().includes(trimmedQuery),
          );
    return { visibleOptions: matches, stickyOptions: sticky };
  }, [options, trimmedQuery]);

  // What the arrow keys walk, in the order the rows render. The pinned rows
  // are walkable but they are not matches, so the announced count is the
  // matches alone: otherwise every count is one too high, and a query that
  // matched nothing announces the escape hatch as a result.
  const walkableValues = useMemo(
    () => [...visibleOptions, ...stickyOptions].map((option) => option.value),
    [visibleOptions, stickyOptions],
  );

  const invalid = Boolean(errorText);
  const describedBy = fieldDescriptionId(
    fieldId,
    invalid,
    Boolean(helperText),
  );

  /** True for the field itself, which Radix reads as outside the popover. */
  function isInsideField(target: EventTarget | null): boolean {
    return target instanceof Node && anchorRef.current?.contains(target) === true;
  }

  function close() {
    setOpen(false);
    setQuery(null);
  }

  function handleOpenChange(next: boolean) {
    if (next) {
      setOpen(true);
      return;
    }
    close();
  }

  function handleFieldKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape" || !open) {
      return;
    }
    // Dismissal is handled here rather than left to the popover's own
    // document-level listener, so the keystroke never reaches the dialog
    // behind it. Closing a list and closing the dialog it sits in are two
    // presses, not one.
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  const emptyMessage = (
    <p className="px-3 py-2 text-body-medium-default text-[var(--content-tertiary)]">
      {emptyText}
    </p>
  );

  const renderRow = (option: SearchableSelectOption) => (
    <Combobox.Option
      key={option.value}
      value={option.value}
      className={({ isSelected, isActive }) =>
        cn(
          "flex w-full items-center gap-2 rounded-md px-3 py-2",
          "text-body-medium-default text-[var(--content-default)] transition-colors",
          isSelected
            ? "bg-[var(--surface-active)]"
            : isActive
              ? "bg-[var(--surface-hover)]"
              : "hover:bg-[var(--surface-hover)]",
        )
      }
    >
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      {option.suffix ? (
        <span className="shrink-0">{option.suffix}</span>
      ) : null}
    </Combobox.Option>
  );

  return (
    <Field
      id={fieldId}
      label={label}
      helperText={helperText}
      errorText={errorText}
      fullWidth
      disabled={disabled}
      className={className}
    >
      <Combobox.Root
        options={walkableValues}
        value={value === "" ? null : value}
        onSelect={(next) => {
          onChange(next);
          close();
        }}
        open={open}
        onOpenChange={handleOpenChange}
        // A query narrows the list to what the typing meant, so Enter commits
        // the top match; with no query it must pick nothing.
        autoActivateFirst={trimmedQuery.length > 0}
        announceCount={visibleOptions.length}
        {...(announceResults ? { announceResults } : {})}
      >
        <Popover.Root open={open} onOpenChange={handleOpenChange}>
          <Popover.Anchor asChild>
            <div ref={anchorRef}>
              <Combobox.Input
                id={fieldId}
                disabled={disabled}
                aria-label={ariaLabel}
                aria-labelledby={
                  ariaLabelledBy ?? (label ? `${fieldId}-label` : undefined)
                }
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                value={query ?? selectedOption?.label ?? ""}
                placeholder={placeholder}
                rightIcon={<ChevronDown className="h-3.5 w-3.5" />}
                fullWidth
                onFocus={(event) => {
                  // The field shows the current selection, so select it: the
                  // first keystroke then starts a query instead of appending
                  // to a model name nobody meant to edit.
                  event.currentTarget.select();
                }}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleFieldKeyDown}
              />
            </div>
          </Popover.Anchor>
          <Popover.Content
            align="start"
            sideOffset={4}
            data-slot="searchable-select-menu"
            className="w-[var(--radix-popover-trigger-width)] p-1"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            // Radix measures "outside" against the popover's own DOM, and the
            // field is not in it: it is the anchor, not the content. Both
            // dismissals therefore have to spare it, or the very interaction
            // that opens the list closes it again. The focus one is not
            // theoretical - a pointer press focuses the field, React mounts
            // the list inside that dispatch, and the same `focusin` then
            // reaches the freshly-mounted layer.
            onPointerDownOutside={(event) => {
              if (isInsideField(event.detail.originalEvent.target)) {
                event.preventDefault();
              }
            }}
            onFocusOutside={(event) => {
              if (isInsideField(event.detail.originalEvent.target)) {
                event.preventDefault();
              }
            }}
          >
            <Combobox.List
              style={{ maxHeight: menuMaxHeight }}
              emptyState={emptyMessage}
            >
              {/* A sticky escape hatch keeps the walkable list non-empty, so
                  `emptyState` alone would never fire on a query that matches
                  no real option. The message is rendered here as well, above
                  the pinned row, which is where it belongs anyway. */}
              {visibleOptions.length === 0
                ? emptyMessage
                : visibleOptions.map(renderRow)}
              {stickyOptions.length > 0 ? (
                <div
                  role="presentation"
                  data-slot="searchable-select-pinned"
                  className="sticky bottom-0 z-10 mt-1 border-t border-[var(--border-element)] bg-[var(--surface-lift)] pt-1"
                >
                  {stickyOptions.map(renderRow)}
                </div>
              ) : null}
            </Combobox.List>
          </Popover.Content>
        </Popover.Root>
      </Combobox.Root>
    </Field>
  );
}

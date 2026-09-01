import { ChevronDown } from "lucide-react";
import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Combobox } from "./combobox";
import { Field, fieldDescriptionId } from "./field";
import {
  OptionListEmpty,
  OptionListRows,
  isListActionValue,
  useDisclosureScroll,
  useOptionListLayout,
  type OptionListItem,
} from "./option-list";
import { Popover } from "./popover";

/**
 * One row of the list. The rows and everything the two shells that draw them
 * share live in `option-list`; this name is the one a `SearchableSelect`
 * caller reaches for.
 */
export type SearchableSelectOption = OptionListItem;

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

/** Breathing room kept between the open list and the edge it collides with. */
const COLLISION_PADDING = 12;

/** The gap the list leaves between itself and the field it hangs from. */
const MENU_SIDE_OFFSET = 4;

/** The frame the rows are drawn in: `p-1` on both edges, plus the border. */
const MENU_FRAME_HEIGHT = 2 * 4 + 2 * 1;

/**
 * A `Select` whose list is filtered by typing: the trigger is the search
 * field, so the whole interaction is one control and one Tab stop.
 *
 * Reach for it over `Select` once the option list outgrows what a person can
 * scan, which for a dropdown is somewhere around a dozen rows. Below that,
 * `Select` is the simpler control and a search field is furniture.
 *
 * It is a composition of pieces this package already owns rather than a third
 * dropdown implementation: `Combobox` supplies the keyboard and ARIA contract
 * of the [combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
 * (focus never leaves the field, the highlight moves through
 * `aria-activedescendant`, the match count is announced), `option-list`
 * supplies the rows and everything that filters, groups and discloses them,
 * and `Popover` supplies the portal. What this file adds is the popover
 * shell: the field the list hangs off, the open state, and the height the
 * list caps itself to.
 *
 * The portal is the reason the composition lives here instead of at each call
 * site: an in-flow list is clipped by the first scrolling ancestor, and this
 * control's natural homes (a modal body, a settings sidepanel) are exactly
 * that. A list that is meant to be on screen the whole time wants `Combobox`
 * in its inline shape around the same rows instead: there is no popup, so
 * there is nothing to portal and nothing to keep clear of.
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
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // `null` while the field is showing the current selection rather than a
  // query. Distinct from `""`, which is a query the user has cleared and so
  // still means "show me everything".
  const [query, setQuery] = useState<string | null>(null);

  const selectedOption = options.find((option) => option.value === value);
  const layout = useOptionListLayout(options, query ?? "", value);

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

  // Set by a pick that acted on the list rather than answering it, and
  // consumed by the close that the pick itself triggers: `Combobox` closes on
  // every commit, which for such a row would shut the list the user was still
  // reading. One flag rather than a per-row click handler, so the keyboard
  // commit behaves the same as the pointer one.
  const keepOpenAfterSelect = useRef(false);

  const holdScrollPosition = useDisclosureScroll(listRef, options);

  function handleOpenChange(next: boolean) {
    if (next) {
      setOpen(true);
      return;
    }
    if (keepOpenAfterSelect.current) {
      keepOpenAfterSelect.current = false;
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

  // The frame is part of what the reported height has to hold, so the rows
  // get what is left of it; without that the list ends flush against the edge
  // it was told to stay clear of.
  const menuHeight = `min(${menuMaxHeight}px, calc(var(--radix-popover-content-available-height, ${menuMaxHeight + MENU_FRAME_HEIGHT}px) - ${MENU_FRAME_HEIGHT}px))`;

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
        options={layout.walkableValues}
        value={value === "" ? null : value}
        onSelect={(next) => {
          keepOpenAfterSelect.current = isListActionValue(options, next);
          if (keepOpenAfterSelect.current) {
            holdScrollPosition();
          }
          onChange(next);
          if (!keepOpenAfterSelect.current) {
            close();
          }
        }}
        open={open}
        onOpenChange={handleOpenChange}
        // A query narrows the list to what the typing meant, so Enter commits
        // the top match; with no query it must pick nothing.
        autoActivateFirst={layout.searching}
        announceCount={layout.matches.length}
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
                onClick={() => {
                  // Focus opens the list, and a pick leaves the focus where
                  // it was. Without this the one gesture that means "show me
                  // the list again" is the one that does nothing.
                  setOpen(true);
                }}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleFieldKeyDown}
              />
            </div>
          </Popover.Anchor>
          <Popover.Content
            align="start"
            sideOffset={MENU_SIDE_OFFSET}
            // Radix keeps the list clear of the viewport's edges and reports
            // what is left as `--radix-popover-content-available-height`,
            // which the list caps itself to below.
            collisionPadding={COLLISION_PADDING}
            data-slot="searchable-select-menu"
            // The edge matters where the list floats over a surface its own
            // colour: without it a menu overlapping a dialog reads as the
            // dialog's card carrying on, cut off at the wrong place.
            className="w-[var(--radix-popover-trigger-width)] border border-[var(--border-subtle)] p-1"
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
              ref={listRef}
              style={{ maxHeight: menuHeight }}
              emptyState={<OptionListEmpty>{emptyText}</OptionListEmpty>}
            >
              <OptionListRows
                layout={layout}
                value={value}
                emptyText={emptyText}
                pinnedSlot="searchable-select-pinned"
              />
            </Combobox.List>
          </Popover.Content>
        </Popover.Root>
      </Combobox.Root>
    </Field>
  );
}

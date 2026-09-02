import { Check, ChevronDown } from "lucide-react";
import {
  Fragment,
  useId,
  useLayoutEffect,
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
  /**
   * Section this row belongs to. Rows carrying the same heading are drawn
   * together under it, sections in the order their first row appears, and a
   * section whose rows are all filtered out disappears with them. Leave unset
   * for a flat list; mixing set and unset headings puts the ungrouped rows in
   * their own unlabelled section, in the same first-appearance order.
   */
  readonly group?: string;
  /**
   * Held back from the list until a query asks for it, for a list that
   * discloses itself progressively (an older version of a model behind the
   * newest). Typing finds it like any other row.
   */
  readonly folded?: boolean;
  /**
   * A row that acts on the list rather than answering it ("Show older
   * versions"). Picking it reports the value and leaves the list open, and it
   * is offered only while the list is being browsed, since a query has
   * already shown what it would have unfolded.
   *
   * It is drawn as a secondary action rather than as a row of the list: a
   * chevron, quieter text, and `aria-expanded`, so nobody reads it as one
   * more thing they could choose.
   */
  readonly listAction?: boolean;
  /**
   * A row a `listAction` has just revealed. The first one in a section is
   * drawn under a hairline, so the revealed block reads as an addition to
   * what was already there rather than as more of it. Ignored while a query
   * is narrowing the list, which has its own reason for every row it shows.
   */
  readonly disclosed?: boolean;
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
  /**
   * Element the open list is kept inside, in place of the viewport. Pass the
   * scrolling box of a host whose own actions sit under the field, such as a
   * dialog body with a footer below it: the list then caps itself to the room
   * left in that box, or flips above the field when more of it is there,
   * instead of opening across the host's edge and over its buttons.
   *
   * Opting in is also a promise to keep `SEARCHABLE_SELECT_MENU_MIN_REACH`
   * of room under the field, since a bounded list never shrinks past the
   * height it can still be read at.
   */
  readonly menuBoundary?: Element | null;
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

/** One option row: `py-2` around a line of `text-body-medium-default`. */
const MENU_ROW_HEIGHT = 33;

/** A section heading, which is pinned and so is never scrolled away. */
const MENU_HEADING_HEIGHT = 22;

/** The pinned block at the foot of the list, with its rule and its margin. */
const MENU_PINNED_HEIGHT = 42;

/** Rows a bounded list shows before it is quicker to type than to scroll. */
const MENU_MIN_ROWS = 3;

/**
 * The shortest list still worth opening: a heading, the pinned row, and three
 * rows between them. Under that a menu is mostly its own furniture, so a
 * bounded list takes this much even where its boundary cannot spare it.
 */
const MENU_MIN_HEIGHT =
  MENU_HEADING_HEIGHT + MENU_MIN_ROWS * MENU_ROW_HEIGHT + MENU_PINNED_HEIGHT;

/** Everything a list reaches past its own rows: the gap, the frame, the pad. */
const MENU_CHROME_HEIGHT =
  MENU_SIDE_OFFSET + MENU_FRAME_HEIGHT + COLLISION_PADDING;

/**
 * How far below the field the list reaches at its full height.
 *
 * A host whose own height follows its content, such as a dialog, has no room
 * under the field until it makes some, and a boundary the host cannot honour
 * only moves the collision. Reserving this much there is what lets the list
 * open at the height it is meant to be read at rather than over whatever sits
 * below it.
 */
export const SEARCHABLE_SELECT_MENU_REACH =
  MENU_CHROME_HEIGHT + DEFAULT_MENU_MAX_HEIGHT;

/**
 * The same reach for a list at its floor, for a host that cannot spare the
 * full one: what it must keep under the field for a bounded list to still be
 * worth reopening.
 */
export const SEARCHABLE_SELECT_MENU_MIN_REACH =
  MENU_CHROME_HEIGHT + MENU_MIN_HEIGHT;

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
  menuBoundary,
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
  const trimmedQuery = (query ?? "").trim().toLowerCase();

  const searching = trimmedQuery !== "";

  const { sections, visibleOptions, stickyOptions } = useMemo(() => {
    const offered = options.filter((option) =>
      option.folded || option.listAction
        ? Boolean(option.folded) === searching
        : true,
    );
    const sticky = offered.filter((option) => option.sticky);
    const matchable = offered.filter((option) => !option.sticky);
    const matches = searching
      ? matchable.filter(
          (option) =>
            option.label.toLowerCase().includes(trimmedQuery) ||
            option.value.toLowerCase().includes(trimmedQuery),
        )
      : matchable;
    // Sections in the order their first surviving row appears, so a heading
    // never outlives the rows it names.
    const byGroup = new Map<string | undefined, SearchableSelectOption[]>();
    for (const option of matches) {
      const rows = byGroup.get(option.group);
      if (rows) {
        rows.push(option);
        continue;
      }
      byGroup.set(option.group, [option]);
    }
    return {
      sections: [...byGroup.entries()].map(([group, rows]) => ({
        group,
        rows,
      })),
      visibleOptions: matches,
      stickyOptions: sticky,
    };
  }, [options, trimmedQuery, searching]);

  // What the arrow keys walk, in the order the rows render: sections first,
  // then the pinned rows. The pinned rows are walkable but they are not
  // matches, so the announced count is the matches alone: otherwise every
  // count is one too high, and a query that matched nothing announces the
  // escape hatch as a result.
  const walkableValues = useMemo(
    () =>
      [...sections.flatMap((section) => section.rows), ...stickyOptions].map(
        (option) => option.value,
      ),
    [sections, stickyOptions],
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

  // Set by a pick that acted on the list rather than answering it, and
  // consumed by the close that the pick itself triggers: `Combobox` closes on
  // every commit, which for such a row would shut the list the user was still
  // reading. One flag rather than a per-row click handler, so the keyboard
  // commit behaves the same as the pointer one.
  const keepOpenAfterSelect = useRef(false);

  // Where the list was scrolled to when a list action fired. Restored before
  // paint, so the rows the action reveals grow downward from where the user
  // was looking instead of sliding the row they just clicked off its line.
  const heldScrollTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (heldScrollTop.current === null || !listRef.current) {
      return;
    }
    listRef.current.scrollTop = heldScrollTop.current;
    heldScrollTop.current = null;
  }, [options]);

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
  // it was told to stay clear of. Floored where a boundary is set, since a
  // boundary can leave less room than a list can be read in.
  const availableHeight = `min(${menuMaxHeight}px, calc(var(--radix-popover-content-available-height, ${menuMaxHeight + MENU_FRAME_HEIGHT}px) - ${MENU_FRAME_HEIGHT}px))`;
  const menuHeight = menuBoundary
    ? `max(${MENU_MIN_HEIGHT}px, ${availableHeight})`
    : availableHeight;

  const emptyMessage = (
    <p className="px-3 py-2 text-body-medium-default text-[var(--content-tertiary)]">
      {emptyText}
    </p>
  );

  const renderRow = (option: SearchableSelectOption, startsBlock = false) => {
    if (option.listAction) {
      return (
        <Combobox.Option
          key={option.value}
          value={option.value}
          // It expands the section it sits in, and says so: the rows it
          // reveals are not on screen yet.
          aria-expanded={false}
          className={cn(
            "flex w-full items-center gap-1.5 rounded-md px-3 py-1.5",
            "text-body-small-default text-[var(--content-tertiary)] transition-colors",
            "hover:text-[var(--content-secondary)]",
            "data-[active]:bg-[var(--surface-active)] data-[active]:text-[var(--content-secondary)]",
          )}
        >
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{option.label}</span>
        </Combobox.Option>
      );
    }
    return (
      <Combobox.Option
        key={option.value}
        value={option.value}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-3 py-2",
          "text-body-medium-default text-[var(--content-default)] transition-colors",
          "hover:bg-[var(--surface-hover)]",
          // The keyboard highlight is the stronger fill and the only one:
          // the selection is marked by its check, so no two rows ever wear
          // the same tint for different reasons.
          "data-[active]:bg-[var(--surface-active)]",
          "aria-selected:text-[var(--content-emphasised)]",
          startsBlock && "mt-1 border-t border-[var(--border-subtle)] pt-2",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{option.label}</span>
        {option.suffix ? (
          <span className="shrink-0">{option.suffix}</span>
        ) : null}
        <Check
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-[var(--content-default)]",
            // Held in the layout either way, so a pick does not shuffle the
            // labels of every row around it.
            option.value === value ? "visible" : "invisible",
          )}
          aria-hidden
        />
      </Combobox.Option>
    );
  };

  /**
   * Rows of one section, with a hairline opening the block a list action
   * revealed. Only the first revealed row carries it, and only while the list
   * is being browsed.
   */
  const renderSectionRows = (rows: readonly SearchableSelectOption[]) => {
    const firstDisclosed = searching
      ? -1
      : rows.findIndex((row) => row.disclosed);
    return rows.map((row, index) => renderRow(row, index === firstDisclosed));
  };

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
          keepOpenAfterSelect.current =
            options.find((option) => option.value === next)?.listAction ===
            true;
          if (keepOpenAfterSelect.current) {
            // The rows this reveals are inserted where the row that revealed
            // them stood, and the list must not move under the hand that is
            // still on it.
            heldScrollTop.current = listRef.current?.scrollTop ?? null;
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
            // The list's natural home is a dialog body, where an unbounded
            // menu runs past the dialog's own edge and buries its actions.
            // The empty boundary is Radix's own default, the viewport: a
            // caller that names a box instead has the list flip or shrink to
            // stay inside it. Either way Radix reports what is left as
            // `--radix-popover-content-available-height`, which the list caps
            // itself to below.
            collisionPadding={COLLISION_PADDING}
            collisionBoundary={menuBoundary ?? []}
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
              emptyState={emptyMessage}
            >
              {/* A sticky escape hatch keeps the walkable list non-empty, so
                  `emptyState` alone would never fire on a query that matches
                  no real option. The message is rendered here as well, above
                  the pinned row, which is where it belongs anyway. */}
              {visibleOptions.length === 0
                ? emptyMessage
                : sections.map((section) =>
                    section.group === undefined ? (
                      <Fragment key="ungrouped">
                        {renderSectionRows(section.rows)}
                      </Fragment>
                    ) : (
                      <Combobox.Group
                        key={section.group}
                        label={section.group}
                        // Never uppercased: these headings carry names whose
                        // own capitalisation is the point (xAI, Z.ai,
                        // DeepSeek), and a transform spells every one of them
                        // wrong. Size, colour and letter-spacing separate a
                        // heading from a row without touching its letters.
                        labelClassName="tracking-wide"
                        stickyLabel
                      >
                        {renderSectionRows(section.rows)}
                      </Combobox.Group>
                    ),
                  )}
              {stickyOptions.length > 0 ? (
                <div
                  role="presentation"
                  data-slot="searchable-select-pinned"
                  className="sticky bottom-0 z-10 mt-1 border-t border-[var(--border-element)] bg-[var(--surface-lift)] pt-1"
                >
                  {stickyOptions.map((option) => renderRow(option))}
                </div>
              ) : null}
            </Combobox.List>
          </Popover.Content>
        </Popover.Root>
      </Combobox.Root>
    </Field>
  );
}

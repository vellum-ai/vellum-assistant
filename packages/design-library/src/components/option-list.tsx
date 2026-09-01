/**
 * The body of a list filtered by typing: which rows a query leaves, how they
 * are grouped, the order the arrow keys walk them in, what a disclosure row
 * reveals, and how each row is drawn.
 *
 * It is a body, not a control. The shell around it belongs to the caller
 * along with the search field, the frame and the copy: `SearchableSelect` is
 * the popover shell, hung off a field that opens it; the model-first create
 * flow is the inline shell, where the list is the question and is on screen
 * until it is answered. Everything the two shells share lives here, so a fix
 * to search, to disclosure, or to the ARIA of a row reaches both of them.
 *
 * `OptionListRows` renders inside a `Combobox.List`, and the walkable order
 * it lays out is what `Combobox.Root` must be given as its `options`. It has
 * no story of its own for that reason: the `SearchableSelect` and `Combobox`
 * stories are what exercise it in a browser.
 */

import { Check, ChevronDown } from "lucide-react";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

import { Combobox } from "./combobox";
import { cn } from "../utils/cn";

export interface OptionListItem {
  /** Identity of the option, and what a pick reports. Must be unique. */
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
   * newest). Typing finds it like any other row, and the current selection is
   * shown whichever side of the fold it is on.
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

export interface OptionListSection {
  /** The heading these rows are filed under; unset for the flat section. */
  readonly group: string | undefined;
  readonly rows: readonly OptionListItem[];
}

/** What one query leaves of a list, in the shape the rows are drawn from. */
export interface OptionListLayout {
  /** Sections in the order they render, each with the rows it keeps. */
  readonly sections: readonly OptionListSection[];
  /** The rows a query found, which is the count worth announcing. */
  readonly matches: readonly OptionListItem[];
  /** The rows pinned to the bottom edge, which no query filters. */
  readonly stickyRows: readonly OptionListItem[];
  /** Every walkable row's value, in the order the rows render. */
  readonly walkableValues: readonly string[];
  /** A query is narrowing the list. */
  readonly searching: boolean;
}

/**
 * Lay out `options` under `query`, with `selectedValue` as the row the list
 * is currently set to.
 *
 * The selection is always laid out, whichever side of a disclosure it fell
 * on: a list that hides the row it is set to cannot show what it is set to,
 * and a folded row found by a query would otherwise vanish the moment the
 * query is cleared. Sparing that one row leaves the rest of the section
 * folded, so the disclosure still has something to disclose.
 */
export function optionListLayout(
  options: readonly OptionListItem[],
  query: string,
  selectedValue: string,
): OptionListLayout {
  const trimmedQuery = query.trim().toLowerCase();
  const searching = trimmedQuery !== "";
  const offered = options.filter((option) => {
    if (selectedValue !== "" && option.value === selectedValue) {
      return true;
    }
    return option.folded || option.listAction
      ? Boolean(option.folded) === searching
      : true;
  });
  const stickyRows = offered.filter((option) => option.sticky);
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
  const byGroup = new Map<string | undefined, OptionListItem[]>();
  for (const option of matches) {
    const rows = byGroup.get(option.group);
    if (rows) {
      rows.push(option);
      continue;
    }
    byGroup.set(option.group, [option]);
  }
  const sections = [...byGroup.entries()].map(([group, rows]) => ({
    group,
    rows,
  }));
  return {
    sections,
    matches,
    stickyRows,
    // What the arrow keys walk, in the order the rows render: the sections
    // first, then the pinned rows. The pinned rows are walkable but they are
    // not matches, so the announced count is the matches alone: otherwise
    // every count is one too high, and a query that matched nothing announces
    // the escape hatch as a result.
    walkableValues: [
      ...sections.flatMap((section) => section.rows),
      ...stickyRows,
    ].map((option) => option.value),
    searching,
  };
}

/** {@link optionListLayout}, recomputed only when its inputs change. */
export function useOptionListLayout(
  options: readonly OptionListItem[],
  query: string,
  selectedValue: string,
): OptionListLayout {
  return useMemo(
    () => optionListLayout(options, query, selectedValue),
    [options, query, selectedValue],
  );
}

/** Whether picking `value` acts on the list rather than answering it. */
export function isListActionValue(
  options: readonly OptionListItem[],
  value: string,
): boolean {
  return options.find((option) => option.value === value)?.listAction === true;
}

/**
 * Hold the list's scroll position across the rows a disclosure inserts.
 *
 * Call the returned function from the pick that fires a `listAction`: the
 * rows it reveals are inserted where the row that revealed them stood, and
 * the list must not move under the hand that is still on it. The held
 * position is restored before paint, so the revealed rows grow downward from
 * where the user was looking.
 */
export function useDisclosureScroll(
  listRef: RefObject<HTMLDivElement | null>,
  options: readonly OptionListItem[],
): () => void {
  const heldScrollTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (heldScrollTop.current === null || !listRef.current) {
      return;
    }
    listRef.current.scrollTop = heldScrollTop.current;
    heldScrollTop.current = null;
  }, [options, listRef]);
  return () => {
    heldScrollTop.current = listRef.current?.scrollTop ?? null;
  };
}

/** What the list says when the query matches nothing. */
export function OptionListEmpty({ children }: { children: ReactNode }) {
  return (
    <p
      data-slot="option-list-empty"
      className="px-3 py-2 text-body-medium-default text-[var(--content-tertiary)]"
    >
      {children}
    </p>
  );
}

export interface OptionListRowsProps {
  readonly layout: OptionListLayout;
  /** The chosen row, marked with a check; the empty string chooses none. */
  readonly value: string;
  /** Rendered in place of the sections when the query matches nothing. */
  readonly emptyText: ReactNode;
  /** `data-slot` on the pinned block, so a shell can name its own foot. */
  readonly pinnedSlot?: string;
}

/**
 * The rows themselves, for the inside of a `Combobox.List`. The shell owns
 * the list's frame, its height and its search field; this owns what is in it.
 */
export function OptionListRows({
  layout,
  value,
  emptyText,
  pinnedSlot = "option-list-pinned",
}: OptionListRowsProps) {
  const { sections, matches, stickyRows, searching } = layout;
  return (
    <>
      {/* A pinned escape hatch keeps the walkable list non-empty, so the
          combobox's own empty state would never fire on a query that matches
          no real option. The message is rendered here instead, above the
          pinned row, which is where it belongs anyway. */}
      {matches.length === 0 ? (
        <OptionListEmpty>{emptyText}</OptionListEmpty>
      ) : (
        sections.map((section) =>
          section.group === undefined ? (
            <SectionRows
              key="ungrouped"
              rows={section.rows}
              value={value}
              searching={searching}
            />
          ) : (
            <Combobox.Group
              key={section.group}
              label={section.group}
              // Never uppercased: these headings carry names whose own
              // capitalisation is the point (xAI, Z.ai, DeepSeek), and a
              // transform spells every one of them wrong. Size, colour and
              // letter-spacing separate a heading from a row without
              // touching its letters.
              labelClassName="tracking-wide"
              stickyLabel
            >
              <SectionRows
                rows={section.rows}
                value={value}
                searching={searching}
              />
            </Combobox.Group>
          ),
        )
      )}
      {stickyRows.length > 0 ? (
        <div
          role="presentation"
          data-slot={pinnedSlot}
          className="sticky bottom-0 z-10 mt-1 border-t border-[var(--border-element)] bg-[var(--surface-lift)] pt-1"
        >
          {stickyRows.map((option) => (
            <OptionRow key={option.value} option={option} value={value} />
          ))}
        </div>
      ) : null}
    </>
  );
}

interface SectionRowsProps {
  readonly rows: readonly OptionListItem[];
  readonly value: string;
  readonly searching: boolean;
}

/**
 * Rows of one section, with a hairline opening the block a list action
 * revealed. Only the first revealed row carries it, and only while the list
 * is being browsed.
 */
function SectionRows({ rows, value, searching }: SectionRowsProps) {
  const firstDisclosed = searching
    ? -1
    : rows.findIndex((row) => row.disclosed);
  return (
    <>
      {rows.map((row, index) => (
        <OptionRow
          key={row.value}
          option={row}
          value={value}
          startsBlock={index === firstDisclosed}
        />
      ))}
    </>
  );
}

interface OptionRowProps {
  readonly option: OptionListItem;
  readonly value: string;
  /** This row opens the block a list action revealed, under a hairline. */
  readonly startsBlock?: boolean;
}

function OptionRow({ option, value, startsBlock = false }: OptionRowProps) {
  if (option.listAction) {
    return (
      <Combobox.Option
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
      value={option.value}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-3 py-2",
        "text-body-medium-default text-[var(--content-default)] transition-colors",
        "hover:bg-[var(--surface-hover)]",
        // The keyboard highlight is the stronger fill and the only one: the
        // selection is marked by its check, so no two rows ever wear the same
        // tint for different reasons.
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
}

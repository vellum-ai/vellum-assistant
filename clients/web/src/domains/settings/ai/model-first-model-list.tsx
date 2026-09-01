/**
 * The model list of the model-first create flow, rendered inline in the host
 * that asks the question rather than in a popover over it.
 *
 * Inline is what the flow is: the list is the question, so it is on screen
 * until it is answered and there is nothing to open, close or reopen. A
 * portaled list in a dialog only as tall as its content has to be bounded to
 * the body to stay off the footer, and the body then has to reserve the room
 * the bound caps, which is a height the dialog carries even when the list is
 * closed. None of that exists here: the dialog is as tall as the list, and the
 * list is in it.
 *
 * Built on the design library's `Combobox` in its inline shape, the way
 * `SttLanguagePicker` is, so the keyboard contract of the combobox pattern is
 * the primitive's and not this file's: focus stays in the search field, the
 * highlight moves through `aria-activedescendant`, Enter commits it, and the
 * match count is announced. Escape is left to the host, which closes the
 * dialog.
 *
 * `SearchableSelect` is the same rows in the popover shape, and stays the
 * control for a field whose list is opened rather than lived in.
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { Check, ChevronDown, Search } from "lucide-react";

import { cn } from "@vellumai/design-library";
import { Combobox } from "@vellumai/design-library/components/combobox";

import { PickerMeta } from "@/domains/settings/ai/provider-picker-availability";
import { useTranslation } from "@/i18n";

export interface ModelFirstListRow {
  /** Identity of the row, and what `onPick` reports. Unique across the list. */
  readonly value: string;
  /** What the row shows, and what the query is matched against. */
  readonly label: string;
  /** Right-aligned annotation: who serves the model, or how many do. */
  readonly meta?: string;
  /**
   * Vendor section this row is filed under. Rows carrying the same heading
   * are drawn together under it, in the order their first row appears.
   */
  readonly group?: string;
  /**
   * Held back from the list until a query asks for it, for the versions a
   * section folds away behind its unfold row. Typing finds it like any other.
   */
  readonly folded?: boolean;
  /**
   * A row that acts on the list rather than answering it ("See more"). It is
   * drawn as a secondary action and offered only while the list is being
   * browsed, since a query has already shown what it would have unfolded.
   */
  readonly listAction?: boolean;
  /**
   * A row a `listAction` has just revealed. The first one in a section opens
   * under a hairline, so the revealed block reads as an addition to what was
   * already there. Ignored while a query is narrowing the list.
   */
  readonly disclosed?: boolean;
  /**
   * Held out of the filter and pinned to the bottom edge, for the row that
   * leaves the list rather than continuing it ("Enter a custom model ID…").
   */
  readonly sticky?: boolean;
}

export interface ModelFirstModelListProps {
  readonly rows: readonly ModelFirstListRow[];
  /** The chosen row, marked with a check; the empty string chooses none. */
  readonly value: string;
  readonly onPick: (value: string) => void;
}

/** What the list caps itself at, and what it takes where that is too tall. */
const LIST_MAX_HEIGHT = "max-h-[min(280px,45vh)]";

export function ModelFirstModelList({
  rows,
  value,
  onPick,
}: ModelFirstModelListProps) {
  const { t } = useTranslation("settings");
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");

  const trimmedQuery = query.trim().toLowerCase();
  const searching = trimmedQuery !== "";

  const { sections, matches, stickyRows } = useMemo(() => {
    const offered = rows.filter((row) =>
      row.folded || row.listAction ? Boolean(row.folded) === searching : true,
    );
    const sticky = offered.filter((row) => row.sticky);
    const matchable = offered.filter((row) => !row.sticky);
    const found = searching
      ? matchable.filter(
          (row) =>
            row.label.toLowerCase().includes(trimmedQuery) ||
            row.value.toLowerCase().includes(trimmedQuery),
        )
      : matchable;
    // Sections in the order their first surviving row appears, so a heading
    // never outlives the rows it names.
    const byGroup = new Map<string | undefined, ModelFirstListRow[]>();
    for (const row of found) {
      const grouped = byGroup.get(row.group);
      if (grouped) {
        grouped.push(row);
        continue;
      }
      byGroup.set(row.group, [row]);
    }
    return {
      sections: [...byGroup.entries()].map(([group, groupRows]) => ({
        group,
        rows: groupRows,
      })),
      matches: found,
      stickyRows: sticky,
    };
  }, [rows, trimmedQuery, searching]);

  // What the arrow keys walk, in the order the rows render: the sections
  // first, then the pinned rows. The pinned rows are walkable but they are
  // not matches, so the announced count is the matches alone: otherwise every
  // count is one too high, and a query that matched nothing announces the
  // escape hatch as a result.
  const walkableValues = useMemo(
    () =>
      [...sections.flatMap((section) => section.rows), ...stickyRows].map(
        (row) => row.value,
      ),
    [sections, stickyRows],
  );

  // Where the list was scrolled to when an unfold row fired. Restored before
  // paint, so the rows it reveals grow downward from where the user was
  // looking instead of sliding the row they just clicked off its line.
  const heldScrollTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (heldScrollTop.current === null || !listRef.current) {
      return;
    }
    listRef.current.scrollTop = heldScrollTop.current;
    heldScrollTop.current = null;
  }, [rows]);

  function handleSelect(next: string): void {
    if (rows.find((row) => row.value === next)?.listAction) {
      // The rows this reveals are inserted where the row that revealed them
      // stood, and the list must not move under the hand that is still on it.
      heldScrollTop.current = listRef.current?.scrollTop ?? null;
    }
    onPick(next);
  }

  const emptyMessage = (
    <p className="px-3 py-2 text-body-medium-default text-[var(--content-tertiary)]">
      {t("profileCreateModelFirst.modelNoMatches")}
    </p>
  );

  const renderRow = (row: ModelFirstListRow, startsBlock = false) => {
    if (row.listAction) {
      return (
        <Combobox.Option
          key={row.value}
          value={row.value}
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
          <span className="min-w-0 truncate">{row.label}</span>
        </Combobox.Option>
      );
    }
    return (
      <Combobox.Option
        key={row.value}
        value={row.value}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-3 py-2",
          "text-body-medium-default text-[var(--content-default)] transition-colors",
          "hover:bg-[var(--surface-hover)]",
          // The keyboard highlight is the stronger fill and the only one: the
          // selection is marked by its check, so no two rows ever wear the
          // same tint for different reasons.
          "data-[active]:bg-[var(--surface-active)]",
          "aria-selected:text-[var(--content-emphasised)]",
          startsBlock && "mt-1 border-t border-[var(--border-subtle)] pt-2",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{row.label}</span>
        {row.meta ? (
          <span className="shrink-0">
            <PickerMeta text={row.meta} />
          </span>
        ) : null}
        <Check
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-[var(--content-default)]",
            // Held in the layout either way, so a pick does not shuffle the
            // labels of every row around it.
            row.value === value ? "visible" : "invisible",
          )}
          aria-hidden
        />
      </Combobox.Option>
    );
  };

  /**
   * Rows of one section, with a hairline opening the block an unfold row
   * revealed. Only the first revealed row carries it, and only while the list
   * is being browsed.
   */
  const renderSectionRows = (sectionRows: readonly ModelFirstListRow[]) => {
    const firstDisclosed = searching
      ? -1
      : sectionRows.findIndex((row) => row.disclosed);
    return sectionRows.map((row, index) =>
      renderRow(row, index === firstDisclosed),
    );
  };

  return (
    <Combobox.Root
      className="flex flex-col gap-2"
      options={walkableValues}
      value={value === "" ? null : value}
      onSelect={handleSelect}
      // The list is the question, so it is never closed. Escape then belongs
      // to the dialog, which is the only thing left to dismiss.
      open
      // A query narrows the list to what the typing meant, so Enter commits
      // the top match; with no query it must pick nothing.
      autoActivateFirst={searching}
      announceCount={matches.length}
      announceResults={(count) =>
        t("profileCreateModelFirst.modelResultsAnnouncement", { count })
      }
    >
      <Combobox.Input
        aria-label={t("profileCreateModelFirst.modelAriaLabel")}
        placeholder={t("profileCreateModelFirst.modelPlaceholder")}
        leftIcon={<Search className="size-4" />}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        fullWidth
        autoFocus
      />
      <Combobox.List
        ref={listRef}
        aria-label={t("profileCreateModelFirst.modelListAriaLabel")}
        // The frame the popover shape got from the menu it opened in: the
        // rows scroll inside it, which is what the pinned heading and the
        // pinned escape hatch stick to.
        className={cn(
          LIST_MAX_HEIGHT,
          "rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] p-1",
        )}
      >
        {/* A pinned escape hatch keeps the walkable list non-empty, so the
            primitive's own empty state would never fire on a query that
            matches no model. The message is rendered here instead, above the
            pinned row, which is where it belongs anyway. */}
        {matches.length === 0
          ? emptyMessage
          : sections.map((section) =>
              section.group === undefined ? (
                <div key="ungrouped">{renderSectionRows(section.rows)}</div>
              ) : (
                <Combobox.Group
                  key={section.group}
                  label={section.group}
                  // Never uppercased: these headings carry names whose own
                  // capitalisation is the point (xAI, Z.ai, DeepSeek), and a
                  // transform spells every one of them wrong.
                  labelClassName="tracking-wide"
                  stickyLabel
                >
                  {renderSectionRows(section.rows)}
                </Combobox.Group>
              ),
            )}
        {stickyRows.length > 0 ? (
          <div
            role="presentation"
            data-slot="model-first-list-pinned"
            className="sticky bottom-0 z-10 mt-1 border-t border-[var(--border-element)] bg-[var(--surface-lift)] pt-1"
          >
            {stickyRows.map((row) => renderRow(row))}
          </div>
        ) : null}
      </Combobox.List>
    </Combobox.Root>
  );
}

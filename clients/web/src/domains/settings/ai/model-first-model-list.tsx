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
 * Only the shell is here. The rows, the filtering, the sections, the
 * disclosure and the order the arrow keys walk come from the design library's
 * `OptionListRows`, which `SearchableSelect` draws the same rows from in its
 * popover shell; the keyboard contract comes from `Combobox` in its inline
 * shape, the way `SttLanguagePicker` takes it. Focus stays in the search
 * field, the highlight moves through `aria-activedescendant`, Enter commits
 * it, and the match count is announced. Escape is left to the host, which
 * closes the dialog.
 */

import { useRef, useState } from "react";

import { Search } from "lucide-react";

import { cn } from "@vellumai/design-library";
import { Combobox } from "@vellumai/design-library/components/combobox";
import {
  OptionListRows,
  isListActionValue,
  useDisclosureScroll,
  useOptionListLayout,
  type OptionListItem,
} from "@vellumai/design-library/components/option-list";

import { useTranslation } from "@/i18n";

export interface ModelFirstModelListProps {
  readonly rows: readonly OptionListItem[];
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

  const layout = useOptionListLayout(rows, query, value);
  const holdScrollPosition = useDisclosureScroll(listRef, rows);

  function handleSelect(next: string): void {
    if (isListActionValue(rows, next)) {
      holdScrollPosition();
    }
    onPick(next);
  }

  return (
    <Combobox.Root
      className="flex flex-col gap-2"
      options={layout.walkableValues}
      value={value === "" ? null : value}
      onSelect={handleSelect}
      // The list is the question, so it is never closed. Escape then belongs
      // to the dialog, which is the only thing left to dismiss.
      open
      // A query narrows the list to what the typing meant, so Enter commits
      // the top match; with no query it must pick nothing.
      autoActivateFirst={layout.searching}
      announceCount={layout.matches.length}
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
        <OptionListRows
          layout={layout}
          value={value}
          emptyText={t("profileCreateModelFirst.modelNoMatches")}
          pinnedSlot="model-first-list-pinned"
        />
      </Combobox.List>
    </Combobox.Root>
  );
}

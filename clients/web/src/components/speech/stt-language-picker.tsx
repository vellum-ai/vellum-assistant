/**
 * The search-first spoken-language picker shared by every STT surface: the
 * Speech-to-Text settings form and the voice room host it inside
 * {@link SttLanguagePickerModal}, the voice first-run card hosts it as an
 * in-modal sub-view. Standalone content on purpose (no Modal chrome of its
 * own), so both hosts can wrap it in their documented patterns.
 *
 * A search field sits on top; below it, a pinned Featured group (the current
 * value, the default row, Multilingual where the provider supports it, and
 * the locale suggestion) and an "All languages" group A-Z, from
 * `sttLanguageGroupsFor`. While a query is active the groups collapse into
 * one flat filtered list with the headers hidden.
 *
 * Keyboard: the design library's `Combobox` in its inline shape (`open`
 * pinned on, since the list is the whole surface). It owns the
 * combobox-with-listbox pattern, so focus stays in the search input for the
 * whole interaction and typing always filters; ArrowDown/ArrowUp/Home/End
 * move a highlight across the visible options (announced through
 * `aria-activedescendant`), Enter selects the highlighted option (or the
 * first match while filtering, via `autoActivateFirst`), and Escape is left
 * to the host (the modal closes, the card sub-view returns to the intro).
 *
 * Selection state arrives as props from `useSttLanguageSelection`, which the
 * host calls at a mount point that outlives this content (it unmounts on
 * close). Keeping the hook out of here preserves its serialized write chain
 * across close/reopen: a pick made while an earlier slow PATCH is still in
 * flight queues behind that write instead of racing it. For the same reason
 * a pick during an in-flight write is allowed, not blocked; the list only
 * dims (`aria-busy`) while a write is pending.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { Check, Search } from "lucide-react";

import { cn } from "@vellumai/design-library";
import { Combobox } from "@vellumai/design-library/components/combobox";

import {
  type SttLanguageOption,
  sttLanguageGroupsFor,
  sttLanguageLabel,
  sttLanguageMatches,
} from "@/lib/stt/language-catalog";

export interface SttLanguagePickerProps {
  /** The currently-selected catalog code, a pending pick included. */
  currentCode: string;
  /** Daemon id of the configured STT provider, scoping the option catalog. */
  configuredProviderId: string;
  /**
   * Locale-suggested code (see `suggestedLanguageForLocale`); joins the
   * Featured group and carries a "Suggested" annotation. Omit where no
   * locale evidence applies.
   */
  suggestedCode?: string | null;
  /** Persist a pick; the owning hook serializes writes in call order. */
  selectLanguage: (code: string) => void;
  /** A write is in flight; the list dims but stays interactive. */
  selecting: boolean;
  /** Close the picker (a pick hot-applies, so it also closes). */
  onDone: () => void;
}

export function SttLanguagePicker({
  currentCode,
  configuredProviderId,
  suggestedCode,
  selectLanguage,
  selecting,
  onDone,
}: SttLanguagePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  const groups = useMemo(
    () =>
      sttLanguageGroupsFor(currentCode, configuredProviderId, suggestedCode),
    [currentCode, configuredProviderId, suggestedCode],
  );
  const filtering = query.trim().length > 0;
  // The flat visible list: featured first, then A-Z, the exact order the
  // grouped rendering shows.
  const visibleOptions = useMemo(() => {
    const all = [...groups.featured, ...groups.rest];
    return filtering
      ? all.filter((option) => sttLanguageMatches(option, query))
      : all;
  }, [groups, filtering, query]);
  // The same order, as the codes the arrow keys walk.
  const visibleCodes = useMemo(
    () => visibleOptions.map((option) => option.code),
    [visibleOptions],
  );

  // Focus lands in the search field so the first keystroke filters. The
  // modal host also redirects its open-autofocus here (see
  // `SttLanguagePickerModal`); running both is idempotent.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const pick = (code: string) => {
    selectLanguage(code);
    onDone();
  };

  const renderOption = (option: SttLanguageOption) => {
    const isSuggested =
      suggestedCode != null &&
      option.code === suggestedCode &&
      option.code !== currentCode;
    const isSelected = option.code === currentCode;
    return (
      <Combobox.Option
        key={option.code}
        value={option.code}
        className={({ isActive }) =>
          cn(
            "flex w-full items-center gap-2 rounded-md px-3 py-2.5 transition-colors",
            // Selected reads as a soft persistent fill + a trailing check,
            // like the voice list; the keyboard highlight uses the hover wash.
            isSelected
              ? "bg-[var(--surface-active)]"
              : isActive
                ? "bg-[var(--surface-hover)]"
                : "hover:bg-[var(--surface-hover)]",
          )
        }
      >
        <span className="min-w-0 flex-1 truncate text-body-medium-default text-[var(--content-default)]">
          {sttLanguageLabel(option)}
          {option.description && (
            <span className="block truncate text-label-small-default text-[var(--content-tertiary)]">
              {option.description}
            </span>
          )}
        </span>
        {isSuggested && (
          <span className="shrink-0 text-label-small-default text-[var(--content-tertiary)]">
            Suggested
          </span>
        )}
        {isSelected && (
          <Check
            aria-hidden
            className="size-4 shrink-0 text-[var(--system-positive-strong)]"
          />
        )}
      </Combobox.Option>
    );
  };

  return (
    <Combobox.Root
      className="flex min-h-0 flex-col gap-2"
      options={visibleCodes}
      value={currentCode}
      onSelect={pick}
      // The list is the whole surface, so it is never closed; Escape stays
      // with the host, which closes the modal or returns to the intro.
      open
      // Land the highlight on the first match so Enter's target is visible;
      // an empty query clears it (Enter must not pick blind).
      autoActivateFirst={filtering}
    >
      <Combobox.Input
        ref={inputRef}
        aria-label="Search languages"
        placeholder="Search languages"
        leftIcon={<Search className="size-4" />}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        fullWidth
      />
      <Combobox.List
        aria-label="Languages"
        aria-busy={selecting}
        className={cn(
          "max-h-[50vh]",
          // The dim signals the in-flight write without blocking a
          // follow-up pick, which the hook queues behind it.
          selecting && "opacity-70",
        )}
        emptyState={
          <p className="px-3 py-2.5 text-body-medium-default text-[var(--content-tertiary)]">
            No languages match.
          </p>
        }
      >
        {filtering ? (
          visibleOptions.map(renderOption)
        ) : (
          <>
            <Combobox.Group label="Featured">
              {groups.featured.map(renderOption)}
            </Combobox.Group>
            <Combobox.Group label="All languages">
              {groups.rest.map(renderOption)}
            </Combobox.Group>
          </>
        )}
      </Combobox.List>
    </Combobox.Root>
  );
}

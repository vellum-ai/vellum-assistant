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
 * Keyboard: the combobox-with-listbox pattern with `aria-activedescendant`.
 * Focus stays in the search input for the whole interaction, so typing
 * always filters; ArrowDown/ArrowUp move a highlight across the visible
 * options (announced through `aria-activedescendant`), Enter selects the
 * highlighted option (or the first match while filtering), and Escape is
 * left to the host (the modal closes, the card sub-view returns to the
 * intro). The options stay real buttons (`role="option"` inside
 * `role="listbox"`) so mouse picks work natively.
 *
 * Selection state arrives as props from `useSttLanguageSelection`, which the
 * host calls at a mount point that outlives this content (it unmounts on
 * close). Keeping the hook out of here preserves its serialized write chain
 * across close/reopen: a pick made while an earlier slow PATCH is still in
 * flight queues behind that write instead of racing it. For the same reason
 * a pick during an in-flight write is allowed, not blocked; the list only
 * dims (`aria-busy`) while a write is pending.
 */

import {
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { Check, Search } from "lucide-react";

import { cn } from "@vellumai/design-library";
import { Input } from "@vellumai/design-library/components/input";

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

/** DOM id for an option, unique per picker instance and per code. */
function optionId(baseId: string, option: SttLanguageOption): string {
  return `${baseId}-option-${option.code === "" ? "default" : option.code}`;
}

export function SttLanguagePicker({
  currentCode,
  configuredProviderId,
  suggestedCode,
  selectLanguage,
  selecting,
  onDone,
}: SttLanguagePickerProps) {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  // Index of the keyboard highlight across the *visible* options, -1 for
  // none. Reset on every query change (to the first match while filtering).
  const [activeIndex, setActiveIndex] = useState(-1);

  const groups = useMemo(
    () =>
      sttLanguageGroupsFor(currentCode, configuredProviderId, suggestedCode),
    [currentCode, configuredProviderId, suggestedCode],
  );
  const filtering = query.trim().length > 0;
  // The flat visible list the keyboard walks: featured first, then A-Z, the
  // exact order the grouped rendering shows.
  const visibleOptions = useMemo(() => {
    const all = [...groups.featured, ...groups.rest];
    return filtering
      ? all.filter((option) => sttLanguageMatches(option, query))
      : all;
  }, [groups, filtering, query]);

  // Focus lands in the search field so the first keystroke filters. The
  // modal host also redirects its open-autofocus here (see
  // `SttLanguagePickerModal`); running both is idempotent.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The current selection starts visible: scroll it into view on mount
  // (focus stays in the search input, so no scroll comes for free).
  useEffect(() => {
    listRef.current
      ?.querySelector('[role="option"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
    // Mount-only: later scrolls follow the keyboard highlight below.
  }, []);

  // Keep the keyboard highlight on screen as the arrows move it.
  useEffect(() => {
    if (activeIndex < 0) {
      return;
    }
    const option = visibleOptions[activeIndex];
    if (!option) {
      return;
    }
    document
      .getElementById(optionId(baseId, option))
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, visibleOptions, baseId]);

  const pick = (code: string) => {
    selectLanguage(code);
    onDone();
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (visibleOptions.length === 0) {
        return;
      }
      setActiveIndex((index) =>
        event.key === "ArrowDown"
          ? Math.min(index + 1, visibleOptions.length - 1)
          : Math.max(index - 1, 0),
      );
      return;
    }
    if (event.key === "Enter") {
      // The highlighted option wins; while filtering with nothing
      // highlighted yet, the first match does (type "ta", Enter).
      const target =
        visibleOptions[activeIndex] ??
        (filtering ? visibleOptions[0] : undefined);
      if (target) {
        event.preventDefault();
        pick(target.code);
      }
    }
  };

  const activeOption = activeIndex >= 0 ? visibleOptions[activeIndex] : null;

  const renderOption = (option: SttLanguageOption) => {
    const isSelected = option.code === currentCode;
    const isActive = option === activeOption;
    const isSuggested =
      suggestedCode != null &&
      option.code === suggestedCode &&
      option.code !== currentCode;
    return (
      <button
        key={option.code}
        id={optionId(baseId, option)}
        type="button"
        role="option"
        aria-selected={isSelected}
        // Focus stays in the search input (aria-activedescendant pattern);
        // the buttons exist for the mouse and are skipped by Tab.
        tabIndex={-1}
        data-active={isActive || undefined}
        onClick={() => pick(option.code)}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2.5 text-left transition-colors",
          // Selected reads as a soft persistent fill + a trailing check,
          // like the voice list; the keyboard highlight uses the hover wash.
          isSelected
            ? "bg-[var(--surface-active)]"
            : isActive
              ? "bg-[var(--surface-hover)]"
              : "hover:bg-[var(--surface-hover)]",
        )}
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
      </button>
    );
  };

  const groupHeader = (id: string, text: string) => (
    <div
      id={id}
      role="presentation"
      className="px-3 pt-2 pb-1 text-label-small-default text-[var(--content-tertiary)]"
    >
      {text}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <Input
        ref={inputRef}
        role="combobox"
        aria-expanded
        aria-controls={listboxId}
        aria-activedescendant={
          activeOption ? optionId(baseId, activeOption) : undefined
        }
        aria-autocomplete="list"
        aria-label="Search languages"
        placeholder="Search languages"
        leftIcon={<Search className="size-4" />}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          // Land the highlight on the first match so Enter's target is
          // visible; an empty query clears it (Enter must not pick blind).
          setActiveIndex(event.target.value.trim().length > 0 ? 0 : -1);
        }}
        onKeyDown={onSearchKeyDown}
        fullWidth
      />
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label="Languages"
        aria-busy={selecting}
        className={cn(
          "flex max-h-[50vh] flex-col overflow-y-auto",
          // The dim signals the in-flight write without blocking a
          // follow-up pick, which the hook queues behind it.
          selecting && "opacity-70",
        )}
      >
        {filtering ? (
          visibleOptions.length > 0 ? (
            visibleOptions.map(renderOption)
          ) : (
            <p className="px-3 py-2.5 text-body-medium-default text-[var(--content-tertiary)]">
              No languages match.
            </p>
          )
        ) : (
          <>
            <div role="group" aria-labelledby={`${baseId}-featured`}>
              {groupHeader(`${baseId}-featured`, "Featured")}
              {groups.featured.map(renderOption)}
            </div>
            <div role="group" aria-labelledby={`${baseId}-all`}>
              {groupHeader(`${baseId}-all`, "All languages")}
              {groups.rest.map(renderOption)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

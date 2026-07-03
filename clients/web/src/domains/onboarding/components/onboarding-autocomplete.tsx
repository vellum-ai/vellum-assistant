/**
 * Lightweight autocomplete field for the research-onboarding form.
 *
 * SPIKE — research-onboarding flow.
 *
 * The design library has no combobox primitive, so this is purpose-built on
 * top of a plain input styled to match the design-library `Input` (same
 * `--field-bg` / `--field-border` / focus tokens). It accepts free text — the
 * suggestion dropdown only exists to make the common cases a single keystroke.
 *
 *   - `TagAutocompleteInput` multi-select chips + suggestion dropdown (Hobbies)
 *
 * Keyboard: ↑/↓ move the highlight, Enter commits the highlighted suggestion
 * (or, for tags, the typed text), Esc closes. The tag field also commits on
 * comma and removes the last chip on Backspace when the input is empty.
 *
 * Suggestions are selected on `mousedown` (not click) with `preventDefault` so
 * the input never blurs out from under the selection.
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Plus, Search } from "lucide-react";

import { Tag } from "@vellumai/design-library/components/tag";
import { cn } from "@vellumai/design-library/utils/cn";

/** Field shell shared by both fields — label + token-matched container. */
const FIELD_BOX = cn(
  "flex w-full items-center gap-1.5 rounded-md border bg-[var(--field-bg)] px-3",
  "border-[var(--field-border)] transition-[border-color,background-color] duration-150 ease-out",
  "focus-within:border-[var(--border-active)]",
);

const BARE_INPUT = cn(
  "min-w-0 flex-1 bg-transparent text-body-medium-lighter text-[var(--content-default)]",
  "placeholder:text-[var(--content-tertiary)] outline-none",
);

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** Case-insensitive substring filter, excluding values already chosen. */
function filterSuggestions(
  suggestions: readonly string[],
  query: string,
  exclude: readonly string[] = [],
  limit = 8,
): string[] {
  const q = normalize(query);
  const excluded = new Set(exclude.map(normalize));
  const out: string[] = [];
  for (const s of suggestions) {
    if (excluded.has(normalize(s))) continue;
    if (q.length === 0 || normalize(s).includes(q)) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/** One row in the dropdown: a predefined suggestion, or a free-text "add" row. */
interface AutocompleteOption {
  value: string;
  /** True for the "Add '<query>'" row (free text not in the suggestion list). */
  isAdd: boolean;
}

/**
 * The floating suggestion list, anchored under the field box. Renders the
 * matching suggestions plus (when the typed text isn't already a suggestion or
 * chip) an "Add '<query>'" row so free-text entry is discoverable. A muted
 * footer advertises that anything can be typed and added, so the list never
 * reads as a fixed menu.
 */
function SuggestionList({
  id,
  options,
  highlighted,
  showAddHint,
  onPick,
  onHover,
}: {
  id: string;
  options: AutocompleteOption[];
  highlighted: number;
  /** Show the "type to add your own" footer (when no add-row is present). */
  showAddHint: boolean;
  onPick: (value: string) => void;
  onHover: (index: number) => void;
}) {
  return (
    <ul
      id={id}
      role="listbox"
      className={cn(
        "absolute left-0 right-0 top-full z-50 mt-1.5 max-h-60 overflow-auto",
        "rounded-lg bg-[var(--surface-lift)] p-1 shadow-[var(--shadow-popover)]",
        "animate-[fadeInUp_0.12s_ease-out]",
      )}
    >
      {options.map((opt, i) => (
        <li
          key={opt.isAdd ? `__add__${opt.value}` : opt.value}
          id={`${id}-opt-${i}`}
          role="option"
          aria-selected={i === highlighted}
          // mousedown (not click) so we beat the input's blur and keep focus.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(opt.value);
          }}
          onMouseEnter={() => onHover(i)}
          className={cn(
            "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5",
            "text-body-medium-lighter text-[var(--content-default)]",
            i === highlighted ? "bg-[var(--surface-base)]" : "bg-transparent",
          )}
        >
          {opt.isAdd ? (
            <>
              <Plus
                size={15}
                className="shrink-0 text-[var(--content-tertiary)]"
              />
              <span className="min-w-0 truncate">
                Add “{opt.value}”
              </span>
              <span className="ml-auto shrink-0 text-body-small-default text-[var(--content-tertiary)]">
                ↵ Enter
              </span>
            </>
          ) : (
            opt.value
          )}
        </li>
      ))}
      {showAddHint && (
        <li
          role="presentation"
          className="mt-0.5 border-t border-[var(--border-base)] px-2.5 pb-0.5 pt-1.5 text-body-small-default text-[var(--content-tertiary)]"
        >
          Type anything and press ↵ to add your own
        </li>
      )}
    </ul>
  );
}

/** Shared label markup matching the design-library `Input` label. */
function FieldLabel({
  htmlFor,
  required,
  children,
}: {
  htmlFor: string;
  required?: boolean;
  children: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="text-body-small-default text-[var(--content-secondary)]"
    >
      {children}
      {required ? (
        <span aria-hidden className="text-[var(--system-negative-strong)]">
          {" *"}
        </span>
      ) : null}
    </label>
  );
}

/** Close the dropdown when focus/click leaves the wrapper. */
function useDismiss(
  ref: React.RefObject<HTMLDivElement | null>,
  close: () => void,
) {
  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [ref, close]);
}

// ---------------------------------------------------------------------------
// Multi-select autocomplete with chips (Hobbies)
// ---------------------------------------------------------------------------

export interface TagAutocompleteInputProps {
  label: string;
  placeholder?: string;
  values: string[];
  onChange: (values: string[]) => void;
  suggestions: readonly string[];
}

export function TagAutocompleteInput({
  label,
  placeholder,
  values,
  onChange,
  suggestions,
}: TagAutocompleteInputProps) {
  const reactId = useId();
  const inputId = `tac-${reactId}`;
  const listId = `tac-list-${reactId}`;
  const wrapperRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);

  const items = useMemo(
    () => filterSuggestions(suggestions, query, values),
    [suggestions, query, values],
  );

  const trimmedQuery = query.trim();
  // Offer a free-text "Add" row unless the typed value is already a visible
  // suggestion or an existing chip — so novel hobbies are one keystroke away and
  // the list never looks like a fixed menu.
  const canAddCustom = useMemo(() => {
    if (!trimmedQuery) return false;
    const q = normalize(trimmedQuery);
    if (values.some((v) => normalize(v) === q)) return false;
    if (items.some((s) => normalize(s) === q)) return false;
    return true;
  }, [trimmedQuery, values, items]);

  const options = useMemo<AutocompleteOption[]>(() => {
    const base = items.map((value) => ({ value, isAdd: false }));
    return canAddCustom
      ? [...base, { value: trimmedQuery, isAdd: true }]
      : base;
  }, [items, canAddCustom, trimmedQuery]);

  useDismiss(wrapperRef, () => setOpen(false));

  useEffect(() => {
    setHighlighted((h) => (h >= options.length ? options.length - 1 : h));
  }, [options.length]);

  const showList = open && options.length > 0;
  // Advertise free-text entry in the footer when no dedicated add-row shows it.
  const showAddHint = !canAddCustom;

  function addChip(raw: string) {
    const next = raw.trim();
    if (!next) return;
    // Case-insensitive dedup; keep the first-entered casing.
    if (!values.some((v) => normalize(v) === normalize(next))) {
      onChange([...values, next]);
    }
    setQuery("");
    setHighlighted(-1);
  }

  function removeChip(target: string) {
    onChange(values.filter((v) => v !== target));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlighted((h) => Math.min(h + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      // Always swallow Enter here so it commits a chip instead of submitting
      // the form mid-list. A highlighted row (suggestion or the add-row) wins;
      // otherwise the typed text is added directly.
      if (showList && highlighted >= 0) {
        e.preventDefault();
        addChip(options[highlighted]!.value);
      } else if (query.trim()) {
        e.preventDefault();
        addChip(query);
      }
    } else if (e.key === "," ) {
      e.preventDefault();
      addChip(query);
    } else if (e.key === "Backspace" && query.length === 0 && values.length > 0) {
      removeChip(values[values.length - 1]!);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={wrapperRef} className="relative flex flex-col gap-1.5">
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      <div className={cn(FIELD_BOX, "min-h-9 flex-wrap py-1.5")}>
        <Search
          size={16}
          aria-hidden
          className="shrink-0 self-center text-[var(--content-tertiary)]"
        />
        {values.map((v) => (
          <Tag
            key={v}
            onRemove={() => removeChip(v)}
            removeLabel={`Remove ${v}`}
            // Default tag bg (--tag-bg-neutral) collides with --field-bg in dark
            // mode; --surface-base contrasts against the field in both themes.
            className="border border-[var(--border-base)] bg-[var(--surface-base)]"
          >
            {v}
          </Tag>
        ))}
        <input
          id={inputId}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            highlighted >= 0 ? `${listId}-opt-${highlighted}` : undefined
          }
          autoComplete="off"
          className={cn(BARE_INPUT, "h-6 w-24")}
          placeholder={values.length === 0 ? placeholder : ""}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
        />
      </div>
      {showList && (
        <SuggestionList
          id={listId}
          options={options}
          highlighted={highlighted}
          showAddHint={showAddHint}
          onPick={addChip}
          onHover={setHighlighted}
        />
      )}
    </div>
  );
}

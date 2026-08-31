import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { Input, type InputProps } from "./input";
import { cn } from "../utils/cn";

/**
 * Combobox primitive: a text field that filters a list of options, with the
 * keyboard contract the `combobox` role promises.
 *
 * Radix has no combobox or listbox primitive, so this one is hand-rolled. It
 * exists because the pattern was already written three times in the app (the
 * spoken-language picker, the onboarding autocomplete, the timezone picker)
 * and each copy answered the keyboard question differently, the last of them
 * by not answering it at all.
 *
 * Compound API: `Combobox.Root`, `Combobox.Input`, `Combobox.List`,
 * `Combobox.Group`, `Combobox.Option`.
 *
 * The wiring it owns, all of it required by the role it declares:
 *
 * - `role="combobox"` on the field with `aria-expanded`, `aria-controls`, and
 *   `aria-autocomplete="list"`, and `role="listbox"` / `role="option"` on the
 *   list, so assistive tech is told what appeared and how large it is.
 * - Focus never leaves the field. The highlight moves through
 *   `aria-activedescendant`, options carry `tabIndex={-1}`, and a pointer
 *   press on an option keeps the field focused. A filtered list is one Tab
 *   stop, not one per row.
 * - ArrowDown / ArrowUp move the highlight (no wrap: from no highlight, Up
 *   reaches the last option), Enter commits it, Escape closes the list and
 *   keeps focus in the field, including when the query matches nothing.
 *   Home and End stay with the text cursor, as the pattern specifies for an
 *   editable combobox, and every key is left alone while an input method is
 *   composing.
 * - A polite live region reports the size of the filtered list as it changes,
 *   since narrowing a list is otherwise a silent event.
 * - The active option is scrolled into view as the highlight moves, and the
 *   selected option is scrolled into view when the list opens.
 *
 * Two shapes, chosen by whether `open` is passed:
 *
 * - **Popup** (`open` omitted): the list opens when the field is focused or
 *   typed into, and closes on Escape, a pointer press outside the root, or a
 *   pick. `onOpenChange` reports every transition.
 * - **Inline** (`open` passed): the caller owns the open state, so a picker
 *   whose list is always on screen can use the same keyboard contract. In
 *   this shape Escape is left alone, so a host dialog still closes on it.
 *
 * @see https://www.w3.org/WAI/ARIA/apg/patterns/combobox/
 */

interface ComboboxContextValue {
  options: readonly string[];
  indexOf: (value: string) => number;
  optionId: (value: string) => string | undefined;
  listboxId: string;
  value: string | null;
  activeValue: string | null;
  setActiveValue: (value: string | null) => void;
  select: (value: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** False in the inline shape, where the caller owns the open state. */
  ownsOpenState: boolean;
}

const ComboboxContext = createContext<ComboboxContextValue | null>(null);

function useComboboxContext(part: string): ComboboxContextValue {
  const context = useContext(ComboboxContext);
  if (!context) {
    throw new Error(`Combobox.${part} must be rendered inside Combobox.Root`);
  }
  return context;
}

export interface ComboboxRootProps extends Omit<
  ComponentProps<"div">,
  "onSelect" | "ref"
> {
  /**
   * Every option the list currently renders, in the order it renders them.
   * This is what the arrow keys walk, so it must match the visible list after
   * filtering. Values are the identity of an option and must be unique.
   */
  options: readonly string[];
  /** The selected option, marked `aria-selected` and scrolled to on open. */
  value?: string | null;
  /** Commit an option (Enter on the highlight, or a click). */
  onSelect: (value: string) => void;
  /** Pass to own the open state (the inline shape); omit for a popup. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Put the highlight on the first option whenever the option list changes,
   * so Enter commits the top match. Set it while a query is active and unset
   * it when the query clears, so Enter on an unfiltered list picks nothing.
   */
  autoActivateFirst?: boolean;
  /**
   * What the live region says when the number of options changes. A filtered
   * list is a silent change on screen for anyone who cannot see it, so the
   * count is announced. Override to translate it, or return an empty string
   * to say nothing.
   */
  announceResults?: (count: number) => string;
  /**
   * The count the live region reports, when it is not `options.length`. A
   * list that walks rows which are not matches (a pinned "enter a custom
   * value" action) would otherwise announce one result more than it found,
   * and announce "1 result" for a query that matched nothing.
   */
  announceCount?: number;
  children?: ReactNode;
}

function defaultAnnouncement(count: number): string {
  const results = count === 1 ? "1 result is" : `${count} results are`;
  return `${results} available. Use the up and down arrow keys to move through them, Enter to choose one.`;
}

function Root({
  options,
  value = null,
  onSelect,
  open,
  onOpenChange,
  autoActivateFirst = false,
  announceResults = defaultAnnouncement,
  announceCount,
  className,
  children,
  ...rest
}: ComboboxRootProps) {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(null);

  const ownsOpenState = open === undefined;
  const isOpen = ownsOpenState ? uncontrolledOpen : open;

  const indexes = useMemo(() => {
    const map = new Map<string, number>();
    options.forEach((option, index) => map.set(option, index));
    return map;
  }, [options]);

  const indexOf = useCallback(
    (option: string) => indexes.get(option) ?? -1,
    [indexes],
  );
  const optionId = useCallback(
    (option: string) => {
      const index = indexes.get(option);
      return index === undefined ? undefined : `${baseId}-option-${index}`;
    },
    [indexes, baseId],
  );

  const setOpen = useCallback(
    (next: boolean) => {
      if (!next) {
        // The highlight dies with the list it points into: leaving it set
        // would leave `aria-activedescendant` naming an unmounted option.
        setActiveValue(null);
      }
      if (ownsOpenState) {
        setUncontrolledOpen(next);
      }
      onOpenChange?.(next);
    },
    [ownsOpenState, onOpenChange],
  );

  // A new option list retargets the highlight: to the top match while a query
  // is narrowing the list, otherwise to nothing unless the previous highlight
  // survived the change.
  const wasAutoActivating = useRef(autoActivateFirst);
  useEffect(() => {
    // Clearing the query is the caller saying Enter should now pick nothing,
    // so the highlight goes with it. Left alone it would survive into the
    // unfiltered list (the option is still in there) and Enter would commit
    // a match for a query that is no longer on screen. Only the transition
    // clears: an option list that changes for its own reasons must not throw
    // away a highlight the user put somewhere with the arrow keys.
    const queryCleared = wasAutoActivating.current && !autoActivateFirst;
    wasAutoActivating.current = autoActivateFirst;
    setActiveValue((previous) => {
      if (autoActivateFirst) {
        return options[0] ?? null;
      }
      if (queryCleared) {
        return null;
      }
      return previous !== null && indexes.has(previous) ? previous : null;
    });
  }, [options, indexes, autoActivateFirst]);

  const select = useCallback(
    (option: string) => {
      onSelect(option);
      setOpen(false);
    },
    [onSelect, setOpen],
  );

  // A press outside closes the popup. The inline shape has no popup to close,
  // and its host (a modal, a card) already owns dismissal.
  useEffect(() => {
    if (!ownsOpenState || !isOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [ownsOpenState, isOpen, setOpen]);

  // Announce the size of the filtered list, but only when it changes and only
  // while the list is on screen: repeating an unchanged count on every
  // keystroke is noise, and a closed list has nothing to report.
  const [announcement, setAnnouncement] = useState("");
  const lastAnnouncedCount = useRef<number | null>(null);
  const reportedCount = announceCount ?? options.length;
  useEffect(() => {
    if (!isOpen) {
      lastAnnouncedCount.current = null;
      setAnnouncement("");
      return;
    }
    if (lastAnnouncedCount.current === reportedCount) {
      return;
    }
    lastAnnouncedCount.current = reportedCount;
    setAnnouncement(announceResults(reportedCount));
  }, [isOpen, reportedCount, announceResults]);

  const context = useMemo<ComboboxContextValue>(
    () => ({
      options,
      indexOf,
      optionId,
      listboxId,
      value,
      activeValue,
      setActiveValue,
      select,
      open: isOpen,
      setOpen,
      ownsOpenState,
    }),
    [
      options,
      indexOf,
      optionId,
      listboxId,
      value,
      activeValue,
      select,
      isOpen,
      setOpen,
      ownsOpenState,
    ],
  );

  return (
    <ComboboxContext value={context}>
      <div
        {...rest}
        // The root's own ref: it is what "outside" is measured against, so
        // the element is not the caller's to take.
        ref={rootRef}
        data-slot="combobox"
        className={cn("relative", className)}
      >
        {children}
        <div
          data-slot="combobox-status"
          role="status"
          aria-live="polite"
          className="sr-only"
        >
          {announcement}
        </div>
      </div>
    </ComboboxContext>
  );
}

/**
 * The text field. Takes every `Input` prop; the combobox wiring and the key
 * handling are added on top, and a caller's own `onKeyDown` still runs first
 * (call `preventDefault` in it to take a key over).
 */
function ComboboxInput({ onKeyDown, onFocus, onChange, ...rest }: InputProps) {
  const context = useComboboxContext("Input");
  const {
    options,
    indexOf,
    optionId,
    listboxId,
    activeValue,
    setActiveValue,
    select,
    open,
    setOpen,
    ownsOpenState,
  } = context;

  const moveTo = (index: number) => {
    const next = options[Math.min(Math.max(index, 0), options.length - 1)];
    setActiveValue(next ?? null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) {
      return;
    }
    // Mid-composition, the keys belong to the input method: arrows walk the
    // candidate list and Enter accepts a candidate. Taking Enter here would
    // commit an option to anyone typing Japanese, Chinese or Korean the
    // moment they accept a word.
    if (event.nativeEvent.isComposing) {
      return;
    }
    // Dismissal is the one key that still has work to do with nothing to
    // move through: a query that matches nothing must stay closeable.
    if (options.length === 0 && event.key !== "Escape") {
      return;
    }
    const current = activeValue === null ? -1 : indexOf(activeValue);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setOpen(true);
        moveTo(current + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        setOpen(true);
        // From nothing, Up reaches the end of the list; from an option, it
        // steps back and stops at the first.
        moveTo(current < 0 ? options.length - 1 : current - 1);
        return;
      // Home and End are deliberately absent. This combobox is editable, and
      // the pattern gives those keys to the text cursor there: taking them
      // for the list would cost a Windows or Linux user the only way to jump
      // to the start or end of what they typed.
      case "Enter":
        if (open && activeValue !== null) {
          event.preventDefault();
          select(activeValue);
        }
        return;
      case "Escape":
        // Only a popup this component opened is ours to close. In the inline
        // shape Escape belongs to the host, so it is left to bubble.
        if (ownsOpenState && open) {
          event.preventDefault();
          setOpen(false);
        }
        return;
      default:
        return;
    }
  };

  return (
    <Input
      {...rest}
      role="combobox"
      aria-expanded={open}
      // Only while the list exists: a reference to an unmounted id is an
      // invalid attribute value, not a hint that something is coming.
      aria-controls={open ? listboxId : undefined}
      aria-autocomplete="list"
      aria-activedescendant={
        open && activeValue !== null ? optionId(activeValue) : undefined
      }
      autoComplete="off"
      onFocus={(event) => {
        onFocus?.(event);
        setOpen(true);
      }}
      onChange={(event) => {
        onChange?.(event);
        // Typing after a pick (or after Escape) puts the list back: the query
        // changed, so there is something new to show.
        setOpen(true);
      }}
      onKeyDown={handleKeyDown}
    />
  );
}

export interface ComboboxListProps extends ComponentProps<"div"> {
  /**
   * What the list says when the query matches nothing. Rendered in place of
   * `children`, inside the listbox, so an open combobox always points at a
   * listbox that exists.
   */
  emptyState?: ReactNode;
}

/**
 * The option list. Renders exactly when the combobox is open, so a caller
 * never gates it themselves: gating it on having rows is what leaves the
 * field claiming `aria-expanded` over a listbox that was never rendered.
 */
function List({ className, children, emptyState, ...rest }: ComboboxListProps) {
  const { listboxId, open, options, activeValue, value, optionId } =
    useComboboxContext("List");

  // Follow the highlight, and show the current selection when the list opens
  // with no highlight yet (it may sit far down a long list).
  const target = activeValue ?? (open ? value : null);
  useEffect(() => {
    if (target === null) {
      return;
    }
    const id = optionId(target);
    if (id === undefined) {
      return;
    }
    document.getElementById(id)?.scrollIntoView?.({ block: "nearest" });
  }, [target, optionId]);

  if (!open) {
    return null;
  }

  return (
    <div
      {...rest}
      id={listboxId}
      role="listbox"
      data-slot="combobox-list"
      className={cn("flex flex-col overflow-y-auto", className)}
    >
      {options.length === 0 ? emptyState : children}
    </div>
  );
}

export interface ComboboxGroupProps extends ComponentProps<"div"> {
  /** Heading text, announced as the group's name. */
  label: ReactNode;
  labelClassName?: string;
}

/** A labelled section of the list, announced as a group by assistive tech. */
function Group({
  label,
  labelClassName,
  children,
  ...rest
}: ComboboxGroupProps) {
  const labelId = useId();
  return (
    <div
      {...rest}
      role="group"
      aria-labelledby={labelId}
      data-slot="combobox-group"
    >
      <div
        id={labelId}
        role="presentation"
        className={cn(
          "px-3 pb-1 pt-2 text-label-small-default text-[var(--content-tertiary)]",
          labelClassName,
        )}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

export interface ComboboxOptionState {
  /** This option is the current value of the combobox. */
  isSelected: boolean;
  /** The keyboard highlight is on this option (`aria-activedescendant`). */
  isActive: boolean;
}

export interface ComboboxOptionProps extends Omit<
  ComponentProps<"button">,
  "value" | "className"
> {
  /** Identity of this option; must appear in `Root`'s `options`. */
  value: string;
  /**
   * A function form receives the option's state, for a row whose selected and
   * highlighted treatments would otherwise fight over the same property. The
   * string form pairs with the `aria-selected:` and `data-[active]:` variants.
   */
  className?: string | ((state: ComboboxOptionState) => string);
}

/**
 * One option. A real button so a mouse pick works natively, kept out of the
 * Tab order because the field holds focus for the whole interaction.
 *
 * The pointer does not move the highlight: that would re-render the whole
 * list on every row the mouse crosses, and a hover treatment in CSS says the
 * same thing for free.
 */
function Option({
  value,
  className,
  onClick,
  onMouseDown,
  ...rest
}: ComboboxOptionProps) {
  const context = useComboboxContext("Option");
  const isSelected = context.value === value;
  const isActive = context.activeValue === value;

  return (
    <button
      {...rest}
      type="button"
      role="option"
      id={context.optionId(value)}
      aria-selected={isSelected}
      data-slot="combobox-option"
      data-active={isActive || undefined}
      tabIndex={-1}
      onMouseDown={(event: MouseEvent<HTMLButtonElement>) => {
        onMouseDown?.(event);
        if (!event.defaultPrevented) {
          // Keep focus in the field: the pick must not blur it out from under
          // the list, and the combobox role says focus stays put.
          event.preventDefault();
        }
      }}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          context.select(value);
        }
      }}
      className={cn(
        "cursor-pointer text-left",
        typeof className === "function"
          ? className({ isSelected, isActive })
          : className,
      )}
    />
  );
}

const Combobox = {
  Root,
  Input: ComboboxInput,
  List,
  Group,
  Option,
};

export { Combobox };

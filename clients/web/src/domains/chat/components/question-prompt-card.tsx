
import {
    ArrowRight,
    Check,
    ChevronLeft,
    ChevronRight,
    Pencil,
    X,
} from "lucide-react";
import {
    type KeyboardEvent as ReactKeyboardEvent,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";

import type { QuestionResponseEntry } from "@/domains/chat/api/event-types";
import { useOptionHotkeys } from "@/hooks/use-option-hotkeys";
import type { QuestionEntry } from "@/types/interaction-ui-types";
import { isPointerCoarse } from "@/utils/pointer";
import { Button, Card, Typography } from "@vellumai/design-library";

export interface QuestionPromptCardProps {
  /** The daemon-supplied request id; needed by the owner for batched POST. */
  requestId: string;
  /**
   * Normalized list of questions. Always at least one entry (the legacy
   * single-question shape is flattened to a one-element batch upstream).
   */
  entries: QuestionEntry[];
  /** True while the final batched POST is in flight. */
  isSubmitting: boolean;
  /**
   * Fires once when the user clicks Done (multi-entry batch) or
   * auto-submits the single-entry batch. Responses are ordered to match
   * `entries[]` so the daemon can pair them back to its questions.
   */
  onSubmitAll: (responses: QuestionResponseEntry[]) => void;
  /**
   * Optional escape hatch. When provided, an X button renders top-right and
   * calls this handler on click. The owner posts `{ kind: "close" }` to the
   * daemon and clears local state — there is no composer free-text intercept
   * fallback in the batched UI.
   */
  onClose?: () => void;
}

/**
 * Paginated question prompt — one entry visible at a time, with chevrons to
 * page through, an inline Skip / Send footer, and a global Done button that
 * fires the batched POST. Local draft state survives navigation so the user
 * can revise prior answers freely.
 *
 * Layout, hotkey, and behavior contract is documented in
 * `.private/plans/ask-question-batched-ui.md` (PR 2).
 */
export function QuestionPromptCard(props: QuestionPromptCardProps) {
  return (
    <Card>
      <QuestionPromptBody {...props} />
    </Card>
  );
}

/**
 * Presentational body of the question prompt — the option rows and the
 * always-visible inline free-text row, **without** a `<Card>` wrapper.
 *
 * Numeric badges on option rows (1..N) double as hotkey hints. The free-text
 * row is marked with a pencil icon instead of a number; the matching hotkey
 * (N+1) focuses the inline input. Numeric badges are hidden on coarse-pointer
 * (touch) devices — the pencil icon stays since it's iconography, not a
 * hotkey hint.
 */
export function QuestionPromptBody({
  entries,
  isSubmitting,
  onSubmitAll,
  onClose,
}: QuestionPromptCardProps) {
  // Defensive: schema requires ≥1 entry, but real-world streams can deliver
  // malformed payloads. Warn so QA notices, but still render something.
  useEffect(() => {
    if (entries.length === 0) {
      console.warn(
        "[QuestionPromptCard] received zero entries; expected ≥1",
      );
    }
  }, [entries.length]);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [draftResponses, setDraftResponses] = useState<
    Record<string, QuestionResponseEntry>
  >({});
  const [freeTextDraft, setFreeTextDraft] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const isBatched = entries.length > 1;
  const currentEntry = entries[currentIndex];
  const currentFreeText = currentEntry
    ? freeTextDraft[currentEntry.id] ?? ""
    : "";
  const hasFreeText = currentFreeText.trim().length > 0;

  // Hide the numeric badges on coarse-pointer (touch) devices — they hint at
  // a hardware-keyboard affordance the user can't trigger. The pencil icon on
  // the free-text row is iconography (not a hotkey hint) and stays visible.
  const [showHotkeyBadges] = useState(() => !isPointerCoarse());

  const recordResponse = useCallback(
    (entry: QuestionEntry, response: QuestionResponseEntry) => {
      const next = { ...draftResponses, [entry.id]: response };
      setDraftResponses(next);
      // Advance to the next unresolved entry (forward only, no wrap). When
      // every entry has a draft, auto-POST the batched submission — no
      // explicit Done button.
      for (let i = currentIndex + 1; i < entries.length; i++) {
        const e = entries[i];
        if (e && !next[e.id]) {
          setCurrentIndex(i);
          return;
        }
      }
      if (entries.every((e) => next[e.id])) {
        const ordered = entries
          .map((e) => next[e.id])
          .filter(Boolean) as QuestionResponseEntry[];
        onSubmitAll(ordered);
      }
    },
    [draftResponses, entries, currentIndex, onSubmitAll],
  );

  const handleOptionClick = (optionId: string) => {
    if (!currentEntry) return;
    recordResponse(currentEntry, {
      questionId: currentEntry.id,
      kind: "option",
      optionId,
    });
  };

  const handleSubmitFreeText = useCallback(() => {
    if (!currentEntry) return;
    const trimmed = currentFreeText.trim();
    if (trimmed.length === 0 || isSubmitting) return;
    recordResponse(currentEntry, {
      questionId: currentEntry.id,
      kind: "free_text",
      text: trimmed,
    });
  }, [currentEntry, currentFreeText, isSubmitting, recordResponse]);

  const handleSkip = useCallback(() => {
    if (!currentEntry || isSubmitting) return;
    // Skip only applies when there's no in-progress free text — otherwise
    // the affordance is replaced by the Send button. We still gate it here
    // so the hotkey path can't sneak a skip past half-typed text.
    if (hasFreeText) return;
    recordResponse(currentEntry, {
      questionId: currentEntry.id,
      kind: "skip",
    });
  }, [currentEntry, hasFreeText, isSubmitting, recordResponse]);

  const handleFocusFreeText = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  const handleSelectByIndex = useCallback(
    (index: number) => {
      if (!currentEntry) return;
      const option = currentEntry.options[index];
      if (!option) return;
      recordResponse(currentEntry, {
        questionId: currentEntry.id,
        kind: "option",
        optionId: option.id,
      });
    },
    [currentEntry, recordResponse],
  );

  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex < entries.length - 1;

  const handlePrev = useCallback(() => {
    if (!canGoPrev) return;
    setCurrentIndex((i) => i - 1);
  }, [canGoPrev]);

  const handleNext = useCallback(() => {
    if (!canGoNext) return;
    setCurrentIndex((i) => i + 1);
  }, [canGoNext]);

  useOptionHotkeys(
    currentEntry?.options.length ?? 0,
    handleSelectByIndex,
    handleFocusFreeText,
    !isSubmitting && currentEntry !== undefined,
    {
      onPrev: isBatched ? handlePrev : undefined,
      onNext: isBatched ? handleNext : undefined,
      // Only register `s` when in a batched UX *and* skipping is meaningful
      // for the current row. The legacy single-question card had no `s`
      // hotkey at all — preserve that parity by gating on `isBatched`. The
      // `hasFreeText` gate is a UX safety net (`recordResponse` itself also
      // guards `hasFreeText`).
      onSkip: !hasFreeText ? handleSkip : undefined,
      onClose,
    },
  );

  const handleInputKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleSubmitFreeText();
      return;
    }
    if (event.key === "Escape") {
      if (currentFreeText.length > 0) {
        event.preventDefault();
        // useOptionHotkeys attaches a native window-level keydown listener;
        // React's synthetic stopPropagation can't reach it, so call
        // stopImmediatePropagation on the native event to prevent the global
        // handler from firing onClose after the input blurs.
        event.nativeEvent.stopImmediatePropagation();
        if (currentEntry) {
          setFreeTextDraft((prev) => ({ ...prev, [currentEntry.id]: "" }));
        }
        inputRef.current?.blur();
        return;
      }
      // Empty input: blur and close directly. The global useOptionHotkeys
      // Escape handler bails out while an input is focused, so without this
      // explicit branch the keystroke would be silently dropped. We
      // `stopImmediatePropagation` because the blur below clears
      // `document.activeElement` before the event reaches the window-level
      // listener, which would otherwise see the no-longer-focused state and
      // fire `onClose` a second time.
      if (onClose) {
        event.preventDefault();
        event.nativeEvent.stopImmediatePropagation();
        inputRef.current?.blur();
        onClose();
      }
    }
  };

  const handleFreeTextChange = (value: string) => {
    if (!currentEntry) return;
    setFreeTextDraft((prev) => ({ ...prev, [currentEntry.id]: value }));
  };

  // Defensive empty-state render — never seen in production (upstream
  // normalizes legacy single-question payloads to a one-element batch and
  // early-outs on truly empty payloads) but tests + malformed daemons should
  // not crash the page.
  if (!currentEntry) {
    return null;
  }

  const currentDraft = draftResponses[currentEntry.id];
  const selectedOptionId =
    currentDraft && currentDraft.kind === "option"
      ? currentDraft.optionId
      : null;
  const isSkipped = currentDraft?.kind === "skip";

  return (
    <>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Typography
            variant="body-medium-default"
            as="div"
            className="text-[color:var(--content-default)]"
          >
            {currentEntry.question}
          </Typography>
          {currentEntry.description && (
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[color:var(--content-tertiary)]"
            >
              {currentEntry.description}
            </Typography>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isBatched && (
            <Typography
              variant="label-small-default"
              as="span"
              className="px-1 text-[color:var(--content-tertiary)]"
            >
              {currentIndex + 1} of {entries.length}
            </Typography>
          )}
          <Button
            variant="ghost"
            size="compact"
            iconOnly={<ChevronLeft />}
            onClick={handlePrev}
            disabled={!canGoPrev || isSubmitting}
            aria-label="Previous question"
          />
          <Button
            variant="ghost"
            size="compact"
            iconOnly={<ChevronRight />}
            onClick={handleNext}
            disabled={!canGoNext || isSubmitting}
            aria-label="Next question"
          />
          {onClose && (
            <Button
              variant="ghost"
              size="compact"
              iconOnly={<X />}
              onClick={onClose}
              disabled={isSubmitting}
              aria-label="Close question"
              className="-mr-1"
            />
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
        {currentEntry.options.map((option, index) => {
          const badgeNumber = index + 1;
          const isSelected = selectedOptionId === option.id;
          return (
            <Button
              key={option.id}
              variant="ghost"
              fullWidth
              disabled={isSubmitting || hasFreeText}
              onClick={() => handleOptionClick(option.id)}
              className="h-auto justify-start whitespace-normal px-3 py-2 text-left"
              aria-label={`Option ${badgeNumber}: ${option.label}`}
            >
              <QuestionRowContents
                badgeNumber={badgeNumber}
                showBadge={showHotkeyBadges}
                label={option.label}
                description={option.description}
                showCheck={isSelected}
              />
            </Button>
          );
        })}

        <div
          className={`flex items-center gap-2 rounded-md px-3 py-2 transition-colors ${
            hasFreeText ? "bg-[var(--surface-base)]" : ""
          }`}
        >
          <span
            aria-hidden="true"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--surface-base)] text-[color:var(--content-secondary)]"
          >
            <Pencil className="h-3.5 w-3.5" />
          </span>
          <input
            ref={inputRef}
            type="text"
            value={currentFreeText}
            onChange={(event) => handleFreeTextChange(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={
              currentEntry.freeTextPlaceholder ?? "Type something else"
            }
            disabled={isSubmitting}
            aria-label="Type a different answer"
            className="text-body-medium-default min-w-0 flex-1 bg-transparent text-[color:var(--content-default)] placeholder:text-[color:var(--content-tertiary)] focus:outline-none disabled:opacity-50"
          />
          {hasFreeText ? (
            <Button
              variant="primary"
              size="compact"
              iconOnly={<ArrowRight />}
              onClick={handleSubmitFreeText}
              disabled={isSubmitting}
              aria-label="Send response"
              className="shrink-0"
            />
          ) : (
            <Button
              variant="outlined"
              onClick={handleSkip}
              disabled={isSubmitting}
              aria-label="Skip this question"
              className="shrink-0"
            >
              {isSkipped ? "Skipped" : "Skip"}
            </Button>
          )}
        </div>

        {isSkipped && !hasFreeText && (
          <Typography
            variant="body-small-default"
            as="p"
            className="px-3 text-[color:var(--content-tertiary)]"
          >
            Skipped — pick an option to override
          </Typography>
        )}
      </div>

    </>
  );
}

interface QuestionRowContentsProps {
  badgeNumber: number;
  /**
   * Whether to render the visible numeric badge (the hotkey hint).
   * Hidden on coarse-pointer devices — see the parent's `showHotkeyBadges`.
   * The badge is decorative; option labels are always present, and
   * `aria-label` on the wrapping button retains the position number for
   * assistive tech regardless of this prop.
   */
  showBadge: boolean;
  label: string;
  description?: string;
  showCheck: boolean;
}

function QuestionRowContents({
  badgeNumber,
  showBadge,
  label,
  description,
  showCheck,
}: QuestionRowContentsProps) {
  return (
    <span className="flex w-full min-w-0 items-start gap-2">
      {showBadge && (
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--surface-base)] text-label-small-default text-[color:var(--content-secondary)]"
        >
          {badgeNumber}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Typography
          variant="body-medium-default"
          as="span"
          className="text-[color:var(--content-default)]"
        >
          {label}
        </Typography>
        {description && (
          <Typography
            variant="body-small-default"
            as="span"
            className="text-[color:var(--content-tertiary)]"
          >
            {description}
          </Typography>
        )}
      </span>
      {showCheck && (
        <Check
          aria-hidden="true"
          className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--primary-base)]"
        />
      )}
    </span>
  );
}

import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Pencil,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import type { QuestionResponseEntry } from "@/domains/chat/api/event-types";
import {
  expandedChromeOpacity,
  minimizedChromeOpacity,
  useQuestionCardMinimize,
} from "@/domains/chat/hooks/use-question-card-minimize";
import { useTranslation } from "@/i18n";
import { useOptionHotkeys } from "@/hooks/use-option-hotkeys";
import type { QuestionEntry } from "@/types/interaction-ui-types";
import { usePointerCoarse } from "@/utils/pointer";
import { Button, Card, cn, Typography } from "@vellumai/design-library";

/** Stable no-op for the hotkeys the minimized card has nothing to act on. */
const NOOP = () => {};

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
  // The card owns its own padding: the bottom inset has to sit above the
  // collapsing rows rather than below them, or minimizing would leave the
  // expanded card's floor behind as dead space under the summary line.
  return (
    <Card.Root noPadding>
      <QuestionPromptBody {...props} />
    </Card.Root>
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
 *
 * ## Minimized state
 *
 * At full height the card covers the assistant message the question is about,
 * which on a phone is most of what is left of the transcript (LUM-3390). The
 * header stays put and everything below it collapses to nothing, leaving the
 * question and an option count docked above the composer. Three ways through
 * it, all driving the same state: the header's chevron minimizes, a vertical
 * swipe anywhere on the card goes either way, and a minimized card reopens
 * from its own header. The swipe carries no grabber of its own, so it is a
 * shortcut for whoever finds it rather than the advertised way through; the
 * chevron and the summary are what the card actually offers.
 *
 * `useQuestionCardMinimize` reduces all of that to one `progress` value, which
 * every moving part below reads. Mid-drag it tracks the finger; at rest it is
 * the state and CSS eases between the two.
 */
export function QuestionPromptBody({
  entries,
  isSubmitting,
  onSubmitAll,
  onClose,
}: QuestionPromptCardProps) {
  const { t } = useTranslation("chat");

  // Defensive: schema requires ≥1 entry, but real-world streams can deliver
  // malformed payloads. Warn so QA notices, but still render something.
  useEffect(() => {
    if (entries.length === 0) {
      console.warn("[QuestionPromptCard] received zero entries; expected ≥1");
    }
  }, [entries.length]);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [draftResponses, setDraftResponses] = useState<
    Record<string, QuestionResponseEntry>
  >({});
  const [freeTextDraft, setFreeTextDraft] = useState<Record<string, string>>(
    {},
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const collapsibleId = useId();

  const minimize = useQuestionCardMinimize();
  const { expand, isMinimized, progress, dragAttr, toggle } = minimize;

  // The two halves of the collapse control. Only one is ever on screen: the
  // chevron while expanded, the summary while minimized.
  const summaryRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  // Whether the control that is about to be retired is the one holding focus.
  // Crossing the state unmounts the chevron and strips the summary of its role
  // and tab stop, so a keyboard user would be left on the document body with
  // the next Tab restarting from the top of the page.
  //
  // Sampled up front rather than read in the effect below, which runs after the
  // commit that already removed the chevron and sent focus to the body. And a
  // sample rather than a flag saying "a control was activated", because the
  // swipe crosses the same state without going through either control: a thumb
  // that was not holding focus must not drag it out of wherever the user left
  // it, and one that was must not lose it.
  const controlHadFocusRef = useRef(false);

  const sampleControlFocus = useCallback(() => {
    const control = isMinimized ? summaryRef.current : chevronRef.current;
    controlHadFocusRef.current =
      control !== null && document.activeElement === control;
  }, [isMinimized]);

  const handleMinimize = useCallback(() => {
    sampleControlFocus();
    toggle();
  }, [sampleControlFocus, toggle]);

  const handleReopen = useCallback(() => {
    sampleControlFocus();
    expand();
  }, [sampleControlFocus, expand]);

  // The third way across, and the only one that does not run through a control.
  // Sampling on touch-start is early enough for any of them: the engine cannot
  // commit before the finger has moved.
  const { onTouchStart } = minimize.dragHandlers;
  const handleCardTouchStart = useCallback(
    (event: ReactTouchEvent) => {
      sampleControlFocus();
      onTouchStart(event);
    },
    [sampleControlFocus, onTouchStart],
  );

  // `role="button"` buys the summary the click, not the keystrokes a real
  // button would have handled for free.
  const handleReopenKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleReopen();
      }
    },
    [handleReopen],
  );

  useEffect(() => {
    if (!controlHadFocusRef.current) {
      return;
    }
    controlHadFocusRef.current = false;
    // The counterpart, which this same commit has just put on screen.
    const replacement = isMinimized ? summaryRef.current : chevronRef.current;
    replacement?.focus();
  }, [isMinimized]);

  const isBatched = entries.length > 1;
  const currentEntry = entries[currentIndex];
  const currentFreeText = currentEntry
    ? (freeTextDraft[currentEntry.id] ?? "")
    : "";
  const hasFreeText = currentFreeText.trim().length > 0;

  // The pointer axis, subscribed rather than sampled: a convertible folding
  // into tablet mode changes it under a card that is already on screen. The
  // numeric badges hint at a hardware-keyboard affordance a thumb can't reach,
  // so a stale read leaves them promising something the device can no longer
  // deliver. The pencil icon on the free-text row is iconography, not a hint,
  // and stays either way.
  const isTouch = usePointerCoarse();
  const showHotkeyBadges = !isTouch;

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
    if (!currentEntry) {
      return;
    }
    recordResponse(currentEntry, {
      questionId: currentEntry.id,
      kind: "option",
      optionId,
    });
  };

  const handleSubmitFreeText = useCallback(() => {
    if (!currentEntry) {
      return;
    }
    const trimmed = currentFreeText.trim();
    if (trimmed.length === 0 || isSubmitting) {
      return;
    }
    recordResponse(currentEntry, {
      questionId: currentEntry.id,
      kind: "free_text",
      text: trimmed,
    });
  }, [currentEntry, currentFreeText, isSubmitting, recordResponse]);

  const handleSkip = useCallback(() => {
    if (!currentEntry || isSubmitting) {
      return;
    }
    // Skip only applies when there's no in-progress free text — otherwise
    // the affordance is replaced by the Send button. We still gate it here
    // so the hotkey path can't sneak a skip past half-typed text.
    if (hasFreeText) {
      return;
    }
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
      if (!currentEntry) {
        return;
      }
      const option = currentEntry.options[index];
      if (!option) {
        return;
      }
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
    if (!canGoPrev) {
      return;
    }
    setCurrentIndex((i) => i - 1);
  }, [canGoPrev]);

  const handleNext = useCallback(() => {
    if (!canGoNext) {
      return;
    }
    setCurrentIndex((i) => i + 1);
  }, [canGoNext]);

  useOptionHotkeys(
    // A minimized card has no rows on screen, so the option, free-text, skip
    // and pagination hotkeys would act invisibly: zero options means no digit
    // resolves to one, and the free-text digit lands on a no-op. Escape is the
    // exception and stays wired in both states, because it is the keyboard's
    // way out of the card and the X beside it is the only other one.
    isMinimized ? 0 : (currentEntry?.options.length ?? 0),
    handleSelectByIndex,
    isMinimized ? NOOP : handleFocusFreeText,
    !isSubmitting && currentEntry !== undefined,
    {
      onPrev: isBatched && !isMinimized ? handlePrev : undefined,
      onNext: isBatched && !isMinimized ? handleNext : undefined,
      // Only register `s` when in a batched UX *and* skipping is meaningful
      // for the current row. The legacy single-question card had no `s`
      // hotkey at all — preserve that parity by gating on `isBatched`. The
      // `hasFreeText` gate is a UX safety net (`recordResponse` itself also
      // guards `hasFreeText`).
      onSkip: !hasFreeText && !isMinimized ? handleSkip : undefined,
      onClose,
    },
  );

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
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
    if (!currentEntry) {
      return;
    }
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

  const expandedOpacity = expandedChromeOpacity(progress);
  const minimizedOpacity = minimizedChromeOpacity(progress);

  return (
    <div
      // `pan-x pinch-zoom` hands the browser everything except the axis this
      // card drags on. Without it a downward swipe can be claimed as native
      // viewport or ancestor panning, and the touch stream is cancelled before
      // `touchend`: the card would follow the finger and then snap back with
      // nothing committed. Zoom and horizontal panning are left alone, since
      // neither is a gesture the card wants.
      data-slot="question-card-surface"
      className="relative flex flex-col p-4 [touch-action:pan-x_pinch-zoom]"
      onTouchStart={handleCardTouchStart}
      onTouchMove={minimize.dragHandlers.onTouchMove}
      onTouchEnd={minimize.dragHandlers.onTouchEnd}
      onTouchCancel={minimize.dragHandlers.onTouchCancel}
      onClickCapture={minimize.dragHandlers.onClickCapture}
    >
      <div
        className={cn(
          "flex items-start gap-2",
          // Only where a drag can start: elsewhere this would take away the
          // ability to select the question text and give nothing back.
          isTouch && "select-none",
        )}
      >
        <div
          ref={summaryRef}
          className={cn(
            "flex min-w-0 flex-1 flex-col",
            isMinimized && "cursor-pointer",
          )}
          // A minimized card carries no chevron of its own, so the summary is
          // what reopens it, by tap and by keyboard alike. Left off while
          // expanded, so the header's own buttons aren't shadowed by a handler
          // that would undo them on the way up.
          //
          // Deliberately not `Button`, and deliberately unlabelled:
          //
          // - A real button would have to swap in at the state flip, and
          //   changing the element type at this position remounts everything
          //   under it. The two crossfading rows below are in there, and they
          //   ease on `grid-template-rows`, which a fresh mount has no previous
          //   value to interpolate from. The collapse would jump instead of
          //   running.
          // - A button's accessible name comes from its contents, and here the
          //   contents are exactly what a reader should hear in place of the
          //   body: the question, and the count of options behind it. An
          //   `aria-label` would replace both with a generic phrase, since
          //   descendants of `role="button"` are flattened into the name.
          role={isMinimized ? "button" : undefined}
          tabIndex={isMinimized ? 0 : undefined}
          aria-expanded={isMinimized ? false : undefined}
          aria-controls={isMinimized ? collapsibleId : undefined}
          onClick={isMinimized ? handleReopen : undefined}
          onKeyDown={isMinimized ? handleReopenKeyDown : undefined}
        >
          <Typography
            variant="body-medium-default"
            as="div"
            className={cn(
              "text-[color:var(--content-default)]",
              isMinimized && "truncate",
            )}
          >
            {currentEntry.question}
          </Typography>
          {currentEntry.description && (
            <div
              className="question-card-motion grid"
              style={{ gridTemplateRows: `${progress}fr` }}
              data-dragging={dragAttr}
              // Collapsed to nothing is invisible, not absent. Without this the
              // description is still read out under a minimized card, and the
              // summary line below it under an expanded one.
              aria-hidden={isMinimized || undefined}
            >
              <div className="min-h-0 overflow-hidden">
                <Typography
                  variant="body-small-default"
                  as="p"
                  className="question-card-motion pt-1 text-[color:var(--content-tertiary)]"
                  style={{ opacity: expandedOpacity }}
                  data-dragging={dragAttr}
                >
                  {currentEntry.description}
                </Typography>
              </div>
            </div>
          )}
          <div
            className="question-card-motion grid"
            style={{ gridTemplateRows: `${1 - progress}fr` }}
            data-dragging={dragAttr}
            aria-hidden={!isMinimized || undefined}
          >
            <div className="min-h-0 overflow-hidden">
              <Typography
                variant="body-small-default"
                as="p"
                className="question-card-motion pt-1 text-[color:var(--content-tertiary)]"
                style={{ opacity: minimizedOpacity }}
                data-dragging={dragAttr}
              >
                {t("questionPromptCard.minimizedSummary", {
                  count: currentEntry.options.length,
                })}
              </Typography>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!isMinimized && (
            // Everything in here belongs to rows that are on screen: the pager
            // pages between them, the chevron puts them away, and the status
            // line says which of them you are on. So they leave with the rows,
            // fading out over the first half of the collapse and unmounting
            // once the state commits, by which point they are already
            // invisible. The chevron points down and stays there: reopening is
            // the minimized header's job, and a second control rotated the
            // other way would only duplicate it.
            <div
              className="question-card-motion flex items-center gap-1"
              style={{ opacity: expandedOpacity }}
              data-dragging={dragAttr}
            >
              {isBatched && (
                // The pager offers movement without saying where from. A
                // sighted reader takes that from the options changing under
                // them, which is nothing a reader paging by button can see, so
                // the count is announced rather than drawn.
                <span role="status" className="sr-only">
                  {t("questionPromptCard.position", {
                    current: currentIndex + 1,
                    total: entries.length,
                  })}
                </span>
              )}
              <Button
                variant="ghost"
                size="compact"
                iconOnly={<ChevronLeft />}
                onClick={handlePrev}
                disabled={!canGoPrev || isSubmitting}
                aria-label={t("questionPromptCard.previousQuestionAria")}
              />
              <Button
                variant="ghost"
                size="compact"
                iconOnly={<ChevronRight />}
                onClick={handleNext}
                disabled={!canGoNext || isSubmitting}
                aria-label={t("questionPromptCard.nextQuestionAria")}
              />
              <Button
                ref={chevronRef}
                variant="ghost"
                size="compact"
                iconOnly={<ChevronDown />}
                onClick={handleMinimize}
                aria-expanded
                aria-controls={collapsibleId}
                aria-label={t("questionPromptCard.minimizeAria")}
              />
            </div>
          )}
          {onClose && (
            <Button
              variant="ghost"
              size="compact"
              iconOnly={<X />}
              onClick={onClose}
              disabled={isSubmitting}
              aria-label={t("questionPromptCard.closeQuestionAria")}
              className="-mr-1"
            />
          )}
        </div>
      </div>

      <div
        id={collapsibleId}
        className="question-card-motion grid"
        style={{ gridTemplateRows: `${progress}fr` }}
        data-dragging={dragAttr}
        // Zero-height rows are still reachable by a screen reader and still in
        // the tab order, so the collapse has to say so as well as show it.
        inert={isMinimized}
      >
        <div className="min-h-0 overflow-hidden">
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
                  aria-label={t("questionPromptCard.optionAria", {
                    number: badgeNumber,
                    label: option.label,
                  })}
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
                  currentEntry.freeTextPlaceholder ??
                  t("questionPromptCard.typeSomethingElsePlaceholder")
                }
                disabled={isSubmitting}
                aria-label={t("questionPromptCard.typeDifferentAnswerAria")}
                className="text-body-medium-default min-w-0 flex-1 bg-transparent text-[color:var(--content-default)] placeholder:text-[color:var(--content-tertiary)] focus:outline-none disabled:opacity-50"
              />
              {hasFreeText ? (
                <Button
                  variant="primary"
                  size="compact"
                  iconOnly={<ArrowRight />}
                  onClick={handleSubmitFreeText}
                  disabled={isSubmitting}
                  aria-label={t("questionPromptCard.sendResponseAria")}
                  className="shrink-0"
                />
              ) : (
                <Button
                  variant="outlined"
                  onClick={handleSkip}
                  disabled={isSubmitting}
                  aria-label={t("questionPromptCard.skipAria")}
                  className="shrink-0"
                >
                  {isSkipped
                    ? t("questionPromptCard.skipped")
                    : t("questionPromptCard.skip")}
                </Button>
              )}
            </div>

            {isSkipped && !hasFreeText && (
              <Typography
                variant="body-small-default"
                as="p"
                className="px-3 text-[color:var(--content-tertiary)]"
              >
                {t("questionPromptCard.skippedHint")}
              </Typography>
            )}
          </div>
        </div>
      </div>
    </div>
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

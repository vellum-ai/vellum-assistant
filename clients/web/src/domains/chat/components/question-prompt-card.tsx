import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Pencil,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import type { QuestionResponseEntry } from "@/domains/chat/api/event-types";
import { useQuestionCardMinimize } from "@/domains/chat/hooks/use-question-card-minimize";
import { useTranslation } from "@/i18n";
import { useIsCompactWidth } from "@/hooks/use-compact-width";
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
   * Fires once when every entry has an answer. Responses are ordered to match
   * `entries[]` so the daemon can pair them back to its questions.
   */
  onSubmitAll: (responses: QuestionResponseEntry[]) => void;
  /**
   * Optional escape hatch, reached by Escape. The owner posts
   * `{ kind: "close" }` to the daemon and clears local state.
   */
  onClose?: () => void;
}

/**
 * Paginated question prompt — one entry visible at a time, with chevrons to
 * page through and an inline Skip / Send footer. Local draft state survives
 * navigation so the user can revise prior answers freely.
 *
 * The card owns its own padding: the bottom inset has to sit above the
 * collapsing rows rather than below them, or minimizing would leave the
 * expanded card's floor behind as dead space under the header.
 */
export function QuestionPromptCard(props: QuestionPromptCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const isCompact = useIsCompactWidth(cardRef);

  return (
    <Card.Root noPadding ref={cardRef}>
      <QuestionPromptBody {...props} isCompact={isCompact} />
    </Card.Root>
  );
}

interface QuestionPromptBodyProps extends QuestionPromptCardProps {
  /**
   * Whether the card is too narrow for the roomy header. Owned by
   * `QuestionPromptCard`, which measures the card itself.
   */
  isCompact: boolean;
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
 * ## Header
 *
 * The question and its description sit beside the pager on a roomy card and
 * above it on a narrow one, from one tree of elements that only changes
 * classes. Swapping the elements themselves would remount the collapsing rows
 * below, and `grid-template-rows` has no previous value to ease from after a
 * fresh mount, so the collapse would jump.
 *
 * ## Minimized state
 *
 * At full height the card covers the assistant message the question is about,
 * which on a narrow card is most of what is left of the transcript (LUM-3390).
 * The header stays put and everything below it collapses to nothing. Three ways
 * through it, all driving the same state: the header's chevron, a vertical
 * swipe anywhere on the card, and a tap on a collapsed card's header. The swipe
 * carries no grabber of its own, so it is a shortcut for whoever finds it
 * rather than the advertised way through.
 *
 * A roomy card sits beside the transcript rather than on top of it, so it
 * carries no collapse chevron and `useQuestionCardMinimize` holds it open.
 */
export function QuestionPromptBody({
  entries,
  isSubmitting,
  onSubmitAll,
  onClose,
  isCompact,
}: QuestionPromptBodyProps) {
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
  const questionId = useId();

  const minimize = useQuestionCardMinimize({ canMinimize: isCompact });
  const { isMinimized, progress, dragAttr, toggle } = minimize;

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
      // Land on an entry that still needs an answer, looking forward first
      // and then wrapping: the chevrons let someone page past a question, so
      // the entry still owed an answer can sit behind the current position
      // as easily as ahead of it. When every entry holds a draft, auto-POST
      // the batch, so there is no explicit Done button.
      for (let step = 1; step < entries.length; step++) {
        const i = (currentIndex + step) % entries.length;
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
    // A minimized card has no rows on screen, so the option, free-text and skip
    // hotkeys would act invisibly: zero options means no digit resolves to one,
    // and the free-text digit lands on a no-op. Escape is the exception and
    // stays wired in both states, because it is the only way out of the card.
    isMinimized ? 0 : (currentEntry?.options.length ?? 0),
    handleSelectByIndex,
    isMinimized ? NOOP : handleFocusFreeText,
    !isSubmitting && currentEntry !== undefined,
    {
      // Paging stays live while collapsed, matching the chevrons beside the
      // count, which do too. The header text is what changes under either one.
      onPrev: isBatched ? handlePrev : undefined,
      onNext: isBatched ? handleNext : undefined,
      // Only register `s` when skipping is meaningful for the current row. The
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
  const hasMetaCluster = isBatched || isCompact;
  // The meta row only earns a line of its own when the pager is on it. A
  // collapse chevron by itself fits at the end of the question's own line, and
  // taking a whole row for it would push the question down for nothing.
  const stackedHeader = isCompact && isBatched;

  return (
    <div
      // `pan-x pinch-zoom` hands the browser everything except the axis this
      // card drags on. Without it a downward swipe can be claimed as native
      // viewport or ancestor panning, and the touch stream is cancelled before
      // `touchend`: the card would follow the finger and then snap back with
      // nothing committed. A roomy card drags on no axis at all, so it leaves
      // the declaration off rather than blocking a finger that only wants to
      // scroll the transcript.
      data-slot="question-card-surface"
      className={cn(
        "relative flex flex-col p-3",
        isCompact && "[touch-action:pan-x_pinch-zoom]",
      )}
      onTouchStart={minimize.dragHandlers.onTouchStart}
      onTouchMove={minimize.dragHandlers.onTouchMove}
      onTouchEnd={minimize.dragHandlers.onTouchEnd}
      onTouchCancel={minimize.dragHandlers.onTouchCancel}
      onClickCapture={minimize.dragHandlers.onClickCapture}
    >
      <div
        data-header={stackedHeader ? "stacked" : "inline"}
        className={cn(
          "flex flex-col gap-4 py-1",
          !stackedHeader && "flex-row gap-2",
          // Beside a roomy card's two lines the cluster reads best centred;
          // beside a narrow one, where the question can wrap to several lines,
          // it belongs level with the first of them.
          !stackedHeader && (isCompact ? "items-start" : "items-center"),
          // Only where a drag can actually start, which is the same pair of
          // conditions the gesture and `touch-action` read. A roomy card holds
          // still under a thumb, so suppressing selection there would cost a
          // long-press on the question and give nothing back.
          isTouch && isCompact && "select-none",
        )}
      >
        {hasMetaCluster && (
          <div
            className={cn(
              "flex shrink-0 items-center gap-4",
              stackedHeader ? "w-full justify-between" : "order-2 justify-end",
            )}
          >
            {isBatched && (
              // Drawn is not announced: a reader who activates Next and stays
              // on the button sees none of the options changing underneath, so
              // the same node that shows the count also reports it.
              <Typography
                variant="body-medium-default"
                as="span"
                role="status"
                className="text-[color:var(--content-tertiary)]"
              >
                {t("questionPromptCard.position", {
                  current: currentIndex + 1,
                  total: entries.length,
                })}
              </Typography>
            )}
            <div className="flex items-center gap-2">
              {isBatched && (
                <>
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
                </>
              )}
              {isCompact && (
                // One button across both states rather than one per state: the
                // browser keeps focus on an element that stays mounted, which
                // is the whole of what a collapse owes a keyboard user here.
                // Its label says what the press does; `aria-describedby` adds
                // which question it does it to, since the question text is
                // header content rather than part of the name.
                <Button
                  variant="ghost"
                  size="compact"
                  iconOnly={isMinimized ? <ChevronUp /> : <ChevronDown />}
                  onClick={toggle}
                  aria-expanded={!isMinimized}
                  aria-controls={collapsibleId}
                  aria-describedby={questionId}
                  aria-label={
                    isMinimized
                      ? t("questionPromptCard.expandAria")
                      : t("questionPromptCard.minimizeAria")
                  }
                />
              )}
            </div>
          </div>
        )}

        <div
          className={cn(
            "flex min-w-0 flex-col gap-1",
            !stackedHeader && "order-1 flex-1",
            isMinimized && "cursor-pointer",
          )}
          // A collapsed card's whole header reopens it, so a thumb has more
          // than the chevron to land on. Deliberately not a control: the
          // chevron beside it already carries the role, the name and the tab
          // stop, and a second one would only shadow it.
          onClick={isMinimized ? toggle : undefined}
        >
          <Typography
            id={questionId}
            variant="body-large-default"
            as="div"
            className={cn(
              "text-[color:var(--content-emphasised)]",
              isMinimized && "line-clamp-2",
            )}
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
      </div>

      <div
        id={collapsibleId}
        data-slot="question-card-body"
        className="question-card-motion grid"
        style={{ gridTemplateRows: `${progress}fr` }}
        data-dragging={dragAttr}
        // Zero-height rows are still reachable by a screen reader and still in
        // the tab order, so the collapse has to say so as well as show it.
        inert={isMinimized}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-2 h-px w-full bg-[var(--border-hover)]" />
          <div className="mt-2 flex flex-col gap-1">
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
                  className="h-auto justify-start whitespace-normal p-1.5 text-left"
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
              className={cn(
                "flex items-center gap-3 rounded-md p-1.5 transition-colors",
                hasFreeText && "bg-[var(--surface-base)]",
              )}
            >
              <RowGlyph>
                <Pencil className="h-3.5 w-3.5" />
              </RowGlyph>
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
                className="px-1.5 text-[color:var(--content-tertiary)]"
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

/**
 * The square that leads a row: a hotkey digit on an option, a pencil on the
 * free-text line. Decorative in both cases: the row's own label carries the
 * meaning.
 */
function RowGlyph({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="text-body-small-default flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--surface-base)] text-[color:var(--content-secondary)]"
    >
      {children}
    </span>
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
    <span className="flex w-full min-w-0 items-center gap-3">
      {showBadge && <RowGlyph>{badgeNumber}</RowGlyph>}
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
          className="h-3.5 w-3.5 shrink-0 text-[var(--primary-base)]"
        />
      )}
    </span>
  );
}

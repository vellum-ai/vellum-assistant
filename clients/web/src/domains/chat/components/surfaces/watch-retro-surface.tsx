import {
  type WatchRetroQuestion,
  type WatchRetroSurfaceData,
  WatchRetroSurfaceDataSchema,
} from "@vellumai/assistant-api";
import {
  Button,
  Card,
  Input,
  ListRow,
  Stepper,
  type StepperStep,
  Tag,
  Typography,
} from "@vellumai/design-library";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  GraduationCap,
  Loader2,
  MessageSquareWarning,
} from "lucide-react";
import { type ComponentType, useCallback, useMemo, useState } from "react";

import { inferCompletionTone } from "@/domains/chat/completion-tone";
import { COMPLETION_TONE_STYLE } from "@/domains/chat/components/surfaces/surface-container";
import type { Surface } from "@/domains/chat/types/types";
import { useTranslation } from "@/i18n";
import { cn } from "@/utils/misc";

/**
 * The end of a Watch (teach mode) session: what the assistant was taught, the
 * few things the recording could not settle, and a last look before any of it
 * is kept.
 *
 * **One thing per page.** The recap is page one, every question gets a page of
 * its own, and the summary is the last. The card stays short enough to read at
 * a glance and no question is a list item to work through.
 *
 * **The flow is a `Stepper`, which is also how you go back.** Steps before the
 * current one are navigable, so a decision made three pages ago is one tap
 * away rather than unreachable. The summary repeats the same affordance as
 * rows, since that is where a user is most likely to want it.
 *
 * **Nothing destructive until the summary.** The recap offers to move forward
 * or to say it read wrong; keeping or dropping the skill is asked once, at the
 * end, next to the thing being kept. A user cannot throw the session away
 * before seeing what it produced.
 *
 * **A `card` template rather than a surface type.** `CardSurface` routes here
 * on `data.template`, so a renderer that predates the template still draws the
 * surface's `title`, `subtitle` and `body` instead of an unsupported-surface
 * notice. The retro is the whole of what a finished session gives the user and
 * the turn writes no prose beside it, so it has to survive an older client.
 *
 * **A pick or a gate is answered by tapping, and nothing is tapped for you.**
 * No option starts selected. The first one is marked as recommended, which is
 * what the payload contract makes it: the model's own reading on a pick and
 * the cautious answer on a gate. A tap commits and advances in one gesture,
 * and until the user has tapped, the page has no forward action at all: no
 * Skip, no Next. A page revisited with an answer already standing shows Next,
 * so moving on does not mean tapping the same option twice.
 *
 * **A fill is skippable and the skip is safe.** It starts on its suggestion,
 * so skipping keeps a working phrase. `defaultAnswerFor` also supplies the
 * first option as a pick's or gate's answer of record, which is only reached
 * when a page was never answered, since the summary is behind every page.
 *
 * **One submission, at the end.** Answers accumulate in local state and go out
 * as a single action payload rather than one turn per question.
 *
 * **The card draws its own completed state.** The router folds only the
 * inherently interactive surface types, and a `card` is not one of them, so
 * once the surface is completed this renderer gives the whole card over to
 * one row naming what happened. The summary for that row is sent along in the
 * action, so history and the daemon's completion event say the same thing.
 */

interface WatchRetroSurfaceProps {
  surface: Surface;
  /** The card's `data.templateData`, which is where the report lives. */
  templateData: unknown;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void | Promise<void>;
}

/** What one answered question contributes to the submitted payload. */
interface WatchRetroAnswer {
  questionId: string;
  kind: WatchRetroQuestion["kind"];
  prompt: string;
  /** The chosen option's label, or the text typed into a `fill`. */
  answer: string;
  /** Set for `pick` and `gate`, so the model can match ids rather than prose. */
  optionId?: string;
  /** True when the user advanced without touching the page. */
  skipped: boolean;
}

/**
 * The answer a question carries before the user touches it.
 *
 * A `fill` starts on its suggestion, which is what makes skipping it an
 * acceptance rather than a blank. A `pick` and a `gate` hold their first
 * option as the answer of record without showing it as selected: the payload
 * contract puts the model's reading first on a pick and the cautious answer
 * first on a gate, so this one rule covers both without the renderer having
 * to know which is which. `skipped` stays true until the user actually taps,
 * which is also what the page reads to decide whether anything is marked.
 */
function defaultAnswerFor(question: WatchRetroQuestion): WatchRetroAnswer {
  const firstOption = question.options?.[0];
  return {
    questionId: question.id,
    kind: question.kind,
    prompt: question.prompt,
    answer:
      question.kind === "fill"
        ? (question.suggestion ?? "")
        : (firstOption?.label ?? ""),
    ...(question.kind === "fill" || !firstOption
      ? {}
      : { optionId: firstOption.id }),
    skipped: true,
  };
}

/**
 * Whether a question can be drawn as a page the user can leave.
 *
 * A `pick` or `gate` with fewer than two options is one button, which is not a
 * question, and an optionless one is a page with no way off it. The surface
 * schema is tolerant by design, so this is where a payload that parsed but
 * cannot be operated gets filtered.
 */
function isAnswerable(question: WatchRetroQuestion): boolean {
  if (!question.id || !question.prompt) {
    return false;
  }
  if (question.kind === "fill") {
    return true;
  }
  return (question.options?.length ?? 0) >= 2;
}

/**
 * The questions this card can actually page through, in payload order.
 *
 * Ids are the key answers are held under and the handle the model matches on,
 * so a repeated one would collapse two pages into a single slot. Nothing
 * upstream guarantees they are distinct, so the first use of an id wins and
 * later claimants are dropped, the same way an unanswerable question is.
 */
function usableQuestions(
  questions: readonly WatchRetroQuestion[],
): WatchRetroQuestion[] {
  const seen = new Set<string>();
  return questions.filter((question) => {
    if (!isAnswerable(question) || seen.has(question.id)) {
      return false;
    }
    seen.add(question.id);
    return true;
  });
}

/** The three ways the card can end, keyed by the action that ends it. */
type WatchRetroOutcome = "answer" | "not_right" | "discard";

interface CompletionStyle {
  Icon: ComponentType<{ className?: string }>;
  colorClass: string;
}

/**
 * How each ending is drawn once the surface is completed: the glyph, its
 * colour, the catalog key for the line beside it, and the summary the action
 * carries to the daemon. `answer` is the one success and `discard` is a void,
 * so both borrow the tones every other completed card uses. `not_right` is
 * neither: the turn picks it up and asks what was off, so it reads as a
 * message sent.
 *
 * `summary` is a fixed English label rather than the catalog string, because
 * it is persisted with the conversation and every other completion summary
 * the daemon writes ("Completed", "Cancelled", "Denied") is English too. The
 * row translates it back through `summaryKey` at render time, so a card
 * answered in one locale still reads in whichever locale opens it.
 */
const OUTCOME_STYLE: Record<
  WatchRetroOutcome,
  CompletionStyle & {
    summary: string;
    summaryKey:
      | "watchRetroSurface.doneSaved"
      | "watchRetroSurface.doneNotRight"
      | "watchRetroSurface.doneDiscarded";
  }
> = {
  answer: {
    ...COMPLETION_TONE_STYLE.success,
    summary: "Skill saved",
    summaryKey: "watchRetroSurface.doneSaved",
  },
  not_right: {
    Icon: MessageSquareWarning,
    colorClass: "text-[color:var(--content-quiet)]",
    summary: "Flagged as not right",
    summaryKey: "watchRetroSurface.doneNotRight",
  },
  discard: {
    ...COMPLETION_TONE_STYLE.neutral,
    summary: "Not saved",
    summaryKey: "watchRetroSurface.doneDiscarded",
  },
};

const OUTCOMES = Object.keys(OUTCOME_STYLE) as WatchRetroOutcome[];

export function WatchRetroSurface({
  surface,
  templateData,
  onAction,
}: WatchRetroSurfaceProps) {
  const { t } = useTranslation("chat");

  // The wire keeps surface `data` opaque; narrow it with the canonical schema
  // (tolerant, so a real payload never fails to parse) rather than an
  // unchecked cast or a re-declared local interface.
  const data = useMemo<WatchRetroSurfaceData>(() => {
    const parsed = WatchRetroSurfaceDataSchema.safeParse(templateData);
    return parsed.success ? parsed.data : { task: "", steps: [] };
  }, [templateData]);

  const questions = useMemo(
    () => usableQuestions(data.questions ?? []),
    [data.questions],
  );

  const [pageIndex, setPageIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  // Which ending was submitted from this mount. The completed row prefers the
  // surface's own summary, which is what history restores; this is the
  // fallback for the gap between the optimistic completion and the daemon's
  // `ui_surface_complete`, when the surface is completed with no summary yet.
  const [outcome, setOutcome] = useState<WatchRetroOutcome | null>(null);
  // Whether the summary has been reached. Once it has, the card is being
  // reviewed rather than filled in, and every page returns there.
  const [reviewed, setReviewed] = useState(false);
  const [answers, setAnswers] = useState<Record<string, WatchRetroAnswer>>(() =>
    Object.fromEntries(
      questions.map((question) => [question.id, defaultAnswerFor(question)]),
    ),
  );

  // Page 0 is the recap, then one page per question. The summary is the last
  // page, and only earns one when there is something to summarize: with no
  // questions the recap already is the summary, and a second page repeating it
  // would be a step that asks nothing.
  const hasSummary = questions.length > 0;
  const summaryIndex = hasSummary ? questions.length + 1 : -1;
  const totalPages = questions.length + (hasSummary ? 2 : 1);
  const onRecap = pageIndex === 0;
  const onSummary = hasSummary && pageIndex === summaryIndex;
  const currentQuestion =
    onRecap || onSummary ? null : questions[pageIndex - 1];

  const steps = useMemo<StepperStep[]>(() => {
    const questionSteps = questions.map((question, index) => ({
      id: question.id,
      // The model names why a question is being asked in `eyebrow`, which is
      // the short label this needs. Numbered only when it did not.
      label:
        question.eyebrow ??
        t("watchRetroSurface.stepQuestion", {
          number: index + 1,
        }),
    }));
    return [
      { id: "__recap", label: t("watchRetroSurface.stepRecap") },
      ...questionSteps,
      ...(hasSummary
        ? [{ id: "__summary", label: t("watchRetroSurface.stepSummary") }]
        : []),
    ];
  }, [hasSummary, questions, t]);

  const goToPage = useCallback(
    (next: number) => {
      setPageIndex(next);
      if (hasSummary && next === summaryIndex) {
        setReviewed(true);
      }
    },
    [hasSummary, summaryIndex],
  );

  const submit = useCallback(
    async (
      actionId: WatchRetroOutcome,
      collected: Record<string, WatchRetroAnswer>,
    ) => {
      if (submitting) {
        return;
      }
      setSubmitting(true);
      setOutcome(actionId);
      try {
        await onAction(surface.surfaceId, actionId, {
          // Ordered by the pages they were asked on, so the model reads them in
          // the order it wrote them rather than in object-key order.
          answers: questions.map(
            (question) => collected[question.id] ?? defaultAnswerFor(question),
          ),
          // Asked for explicitly: the card rides an ordinary `card` surface,
          // which the daemon does not treat as one-shot, and every page's
          // answer goes out in this one payload. Without it the card would
          // stay answerable after it had been answered.
          _completeSurface: true,
          // What the daemon records as the completion. Without it the
          // completion is summarised as a bare "Completed", and that is what
          // history would restore in place of what actually happened.
          _completionSummary: OUTCOME_STYLE[actionId].summary,
        });
      } finally {
        // Released unconditionally, matching `SurfaceContainer`. A rejection is
        // not the signal a failure arrives on: `handleSurfaceAction` reports a
        // failed submit to the user and returns normally, so a reset that only
        // ran on a thrown error would leave every control disabled after a
        // dropped request, with the composer still blocked behind an
        // interactive surface nobody can answer.
        setSubmitting(false);
      }
    },
    [onAction, questions, submitting, surface.surfaceId],
  );

  /**
   * Move forward one page, or submit when there is nowhere left to go.
   *
   * Only a card with no questions ends by advancing; everything else stops on
   * the summary, where saving is an explicit act rather than the far end of
   * tapping Next.
   */
  const advance = useCallback(
    (next: Record<string, WatchRetroAnswer>) => {
      setAnswers(next);
      if (pageIndex >= totalPages - 1) {
        void submit("answer", next);
        return;
      }
      // A page left after the summary has been seen goes back to it. Someone
      // who jumped back from the summary to change one answer came to change
      // that answer, not to walk forward through the questions they had
      // already settled.
      goToPage(reviewed ? summaryIndex : pageIndex + 1);
    },
    [goToPage, pageIndex, reviewed, submit, summaryIndex, totalPages],
  );

  /** Record an answer and move on. A tap on an option is both, in one gesture. */
  const answerAndAdvance = useCallback(
    (question: WatchRetroQuestion, answer: WatchRetroAnswer) => {
      advance({ ...answers, [question.id]: answer });
    },
    [advance, answers],
  );

  const goBack = useCallback(() => {
    goToPage(Math.max(0, pageIndex - 1));
  }, [goToPage, pageIndex]);

  const heading = data.task || t("watchRetroSurface.untitledTask");

  if (surface.completed) {
    return (
      <CompletedRow
        heading={heading}
        summary={surface.completionSummary}
        outcome={outcome}
        tone={surface.completionTone}
      />
    );
  }

  return (
    <Card padding="lg" bordered>
      {totalPages > 1 && (
        // The session's own facts ride the end of the step row rather than
        // sitting above the title. Three left-aligned lines of near-equal
        // weight gave the recap no first thing to read; the title is that
        // thing, so everything else gets out of its column.
        <div className="mb-6 flex items-end gap-4 border-b border-[var(--border-base)]">
          <Stepper
            steps={steps}
            current={pageIndex}
            disabled={submitting}
            onStepSelect={goToPage}
            className="min-w-0 flex-1 border-b-0"
          />
          {data.eyebrow && <SessionFacts eyebrow={data.eyebrow} />}
        </div>
      )}

      {onRecap && (
        <RecapPage
          data={data}
          heading={heading}
          // Both only appear here when there is no step row and no summary to
          // carry them, which is the single-page card.
          showEyebrow={totalPages === 1}
          showPurpose={!hasSummary}
        />
      )}

      {currentQuestion && (
        <QuestionPage
          question={currentQuestion}
          answer={answers[currentQuestion.id]}
          disabled={submitting}
          onFillChange={(value) => {
            setAnswers((prev) => ({
              ...prev,
              [currentQuestion.id]: {
                ...defaultAnswerFor(currentQuestion),
                ...prev[currentQuestion.id],
                answer: value,
                skipped: false,
              },
            }));
          }}
          onPick={(optionId, label) => {
            answerAndAdvance(currentQuestion, {
              questionId: currentQuestion.id,
              kind: currentQuestion.kind,
              prompt: currentQuestion.prompt,
              answer: label,
              optionId,
              skipped: false,
            });
          }}
        />
      )}

      {onSummary && (
        <SummaryPage
          data={data}
          questions={questions}
          answers={answers}
          disabled={submitting}
          onEdit={goToPage}
        />
      )}

      {/* Back left, everything else right, primary last. That is the shape
          `form-surface` uses for its paged footer and the order every
          `Modal.Footer` puts its buttons in, so the forward action is always
          the rightmost thing on the card. */}
      <div className="mt-6 flex items-center justify-between gap-2">
        <div>
          {!onRecap && (
            <Button
              variant="outlined"
              disabled={submitting}
              leftIcon={<ChevronLeft />}
              onClick={goBack}
            >
              {t("watchRetroSurface.back")}
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Says the recap read wrong, which is a correction rather than a
              refusal: the turn picks it up and asks what was off. */}
          {onRecap && (
            <Button
              variant="ghost"
              disabled={submitting}
              onClick={() => {
                void submit("not_right", answers);
              }}
            >
              {t("watchRetroSurface.somethingOff")}
            </Button>
          )}

          {currentQuestion?.kind === "fill" && (
            <Button
              variant="ghost"
              disabled={submitting}
              onClick={() => {
                // The suggestion is already in `answers`, so a skip only has
                // to move on. It stays marked skipped so the model can tell an
                // accepted suggestion from a typed one.
                advance(answers);
              }}
            >
              {t("watchRetroSurface.skip")}
            </Button>
          )}

          {/* The one place the session can be thrown away, next to the thing
              being thrown away. */}
          {(onSummary || totalPages === 1) && (
            <Button
              variant="ghost"
              disabled={submitting}
              onClick={() => {
                void submit("discard", answers);
              }}
            >
              {t("watchRetroSurface.dontSave")}
            </Button>
          )}

          {/* A `pick` and a `gate` commit on tap, so their page earns an
              advance button only once an answer is standing: a page revisited
              from the summary can be left without tapping the same option
              again. The recap, a `fill` and the summary have nothing to tap,
              so they always keep one. */}
          {(onRecap ||
            onSummary ||
            currentQuestion?.kind === "fill" ||
            (currentQuestion && !answers[currentQuestion.id]?.skipped)) && (
            <Button
              variant="primary"
              disabled={submitting}
              leftIcon={
                submitting ? <Loader2 className="animate-spin" /> : undefined
              }
              rightIcon={
                onSummary || totalPages === 1 ? undefined : <ChevronRight />
              }
              onClick={() => {
                advance(answers);
              }}
            >
              {onSummary || totalPages === 1
                ? t("watchRetroSurface.save")
                : onRecap
                  ? t("watchRetroSurface.looksRight")
                  : t("watchRetroSurface.next")}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * What the card becomes once it has been answered: the task, and one line
 * saying what happened to it.
 *
 * The surface's own summary is authoritative: it is what the daemon's
 * completion event set and what a restored conversation carries, and it is
 * the ending that actually landed when two clients answered the same card.
 * Only while the surface is completed with no summary yet does the ending
 * submitted from this mount fill in, and a completed surface with neither,
 * which is a card answered elsewhere before this client learned the
 * template, still says it is done.
 *
 * The glyph and the wording follow the ending. From a summary the ending is
 * read back off the card's own fixed labels, and the line is then drawn from
 * the catalog in the current locale. A summary the card did not write, such
 * as a bare "Completed" from a daemon that ignored the request, is shown as
 * it is and takes the tone every other completed card would infer from it.
 */
function CompletedRow({
  heading,
  summary,
  outcome,
  tone,
}: {
  heading: string;
  summary: string | undefined;
  outcome: WatchRetroOutcome | null;
  tone: Surface["completionTone"];
}) {
  const { t } = useTranslation("chat");
  const resolvedOutcome = summary
    ? (OUTCOMES.find(
        (candidate) => summary === OUTCOME_STYLE[candidate].summary,
      ) ?? null)
    : outcome;
  const style: CompletionStyle = resolvedOutcome
    ? OUTCOME_STYLE[resolvedOutcome]
    : COMPLETION_TONE_STYLE[tone ?? inferCompletionTone(summary)];
  const line = resolvedOutcome
    ? t(OUTCOME_STYLE[resolvedOutcome].summaryKey)
    : summary || t("surfaceRouter.done");

  return (
    <Card padding="sm" bordered>
      <div className="flex items-center gap-3">
        <GraduationCap className="h-4 w-4 shrink-0 text-[color:var(--content-quiet)]" />
        <Typography
          variant="body-medium-default"
          as="span"
          className="min-w-0 flex-1 truncate text-[color:var(--content-strong)]"
        >
          {heading}
        </Typography>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-body-medium-default",
            style.colorClass,
          )}
        >
          <style.Icon className="h-4 w-4 shrink-0" />
          {line}
        </span>
      </div>
    </Card>
  );
}

/** The teaching's own line: how long it took, and how much was seen. */
function SessionFacts({ eyebrow }: { eyebrow: string }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 pb-2 text-[color:var(--content-quiet)]">
      <GraduationCap className="h-3.5 w-3.5 shrink-0" />
      <Typography variant="body-small-default">{eyebrow}</Typography>
    </div>
  );
}

/** Page one: what the session was taught, and nothing to answer. */
function RecapPage({
  data,
  heading,
  showEyebrow,
  showPurpose,
}: {
  data: WatchRetroSurfaceData;
  heading: string;
  showEyebrow: boolean;
  showPurpose: boolean;
}) {
  return (
    <div>
      {showEyebrow && data.eyebrow && (
        <div className="mb-1.5">
          <SessionFacts eyebrow={data.eyebrow} />
        </div>
      )}

      {/* The one thing to read first. The steps under it are what the page is
          actually asking about, so nothing else competes for the top. */}
      <Typography variant="title-medium" as="h3">
        {heading}
      </Typography>

      {showPurpose && data.purpose && (
        <Typography
          variant="body-medium-lighter"
          as="p"
          className="mt-1.5 text-[color:var(--content-quiet)]"
        >
          {data.purpose}
        </Typography>
      )}

      {data.steps.length > 0 && (
        <ol className="mt-6 grid gap-2.5">
          {data.steps.map((step, index) => (
            <li
              key={`${index}-${step}`}
              className="grid grid-cols-[1.25rem_1fr] items-baseline gap-3"
            >
              <Typography
                variant="body-small-default"
                className="text-right tabular-nums text-[color:var(--content-quiet)]"
              >
                {index + 1}
              </Typography>
              <Typography variant="body-medium-default">{step}</Typography>
            </li>
          ))}
        </ol>
      )}

      {/* A bounded recording says so here rather than hedging inside the steps:
          the steps are what was taught, and the gap is a fact about the
          session. */}
      {data.coverage && (
        <Typography
          variant="body-small-default"
          as="p"
          className="mt-5 text-[color:var(--content-quiet)]"
        >
          {data.coverage}
        </Typography>
      )}
    </div>
  );
}

/** One question, alone on its page. */
function QuestionPage({
  question,
  answer,
  disabled,
  onFillChange,
  onPick,
}: {
  question: WatchRetroQuestion;
  answer: WatchRetroAnswer | undefined;
  disabled: boolean;
  onFillChange: (value: string) => void;
  onPick: (optionId: string, label: string) => void;
}) {
  const { t } = useTranslation("chat");
  const promptId = `watch-retro-q-${question.id}`;
  // Only a tapped answer is marked. The answer of record before any tap is
  // the first option, and it stays unmarked so the recommendation is visible
  // without reading as a choice already made.
  const selectedOptionId =
    answer && !answer.skipped ? answer.optionId : undefined;

  return (
    <div>
      {question.kind === "fill" ? (
        <Typography variant="title-small" as="label" htmlFor={promptId}>
          {question.prompt}
        </Typography>
      ) : (
        <Typography variant="title-small" as="h3" id={promptId}>
          {question.prompt}
        </Typography>
      )}

      {question.kind === "fill" ? (
        <div className="mt-5">
          {/* `Input` is `w-fit` by default, which sizes the box to whatever the
              suggestion happens to be and clips the rest of it. */}
          <Input
            id={promptId}
            type="text"
            fullWidth
            disabled={disabled}
            value={answer?.answer ?? ""}
            onChange={(event) => {
              onFillChange(event.target.value);
            }}
          />
        </div>
      ) : (
        <div
          className="mt-5 grid gap-2"
          role="group"
          aria-labelledby={promptId}
        >
          {/* Rows in the shape `choice-surface` gives its options, which is the
              app's single-select: separate raised rows, no dividers, a mark
              that says which one is standing. Two primitives sit closer to
              this than they belong. `ListRow` draws a `[&+&]` hairline for a
              flush settings list, which under a filled row reads as a section
              break rather than as the gap between two options. And a
              `RadioGroup` cannot commit on tap: Radix moves the selection on
              arrow keys, so advancing on change carries a keyboard user off
              the page before they reach the third option. A button per option
              keeps the tap-to-commit gesture and leaves Tab and Enter
              working. */}
          {(question.options ?? []).map((option, index) => {
            const selected = selectedOptionId === option.id;
            return (
              <button
                key={option.id || `${index}-${option.label}`}
                type="button"
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => {
                  onPick(option.id, option.label);
                }}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-3 rounded-lg p-3 text-left transition-colors",
                  "bg-[var(--surface-overlay)] hover:bg-[var(--surface-active)]",
                  "disabled:cursor-default disabled:opacity-70",
                  selected && "ring-1 ring-[var(--primary-base)]",
                )}
              >
                {/* The mark, not the fill, is what says which option is
                    standing: a background on its own reads as a section of
                    its own when the middle option carries it. */}
                <span
                  aria-hidden
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                    selected
                      ? "border-transparent bg-[var(--primary-base)] text-[var(--content-inset)]"
                      : "border-[var(--border-element)]",
                  )}
                >
                  {selected && <Check className="h-3.5 w-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Typography
                      as="span"
                      variant="body-medium-default"
                      className="text-[color:var(--content-strong)]"
                    >
                      {option.label}
                    </Typography>
                    {/* The first option is the recommended one by contract:
                        the recording's own reading on a pick, the cautious
                        answer on a gate. Marked rather than preselected, so
                        the recommendation is visible and the answer is still
                        the user's. */}
                    {index === 0 && (
                      <Tag tone="info">
                        {t("watchRetroSurface.recommended")}
                      </Tag>
                    )}
                  </span>
                  {option.note && (
                    <Typography
                      as="span"
                      variant="body-small-default"
                      className="mt-0.5 block text-[color:var(--content-quiet)]"
                    >
                      {option.note}
                    </Typography>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The last page: the skill as it will be saved.
 *
 * Every line is the answer to something asked earlier and navigates back to
 * where it was asked, so changing a decision costs one tap rather than a
 * restart. The trigger phrase leads because it is the part the user typed and
 * the part they will have to remember.
 */
function SummaryPage({
  data,
  questions,
  answers,
  disabled,
  onEdit,
}: {
  data: WatchRetroSurfaceData;
  questions: readonly WatchRetroQuestion[];
  answers: Record<string, WatchRetroAnswer>;
  disabled: boolean;
  onEdit: (pageIndex: number) => void;
}) {
  const { t } = useTranslation("chat");
  const triggerIndex = questions.findIndex(
    (question) => question.kind === "fill",
  );
  const trigger = triggerIndex >= 0 ? questions[triggerIndex] : undefined;

  return (
    <div>
      <Typography variant="title-medium" as="h3">
        {t("watchRetroSurface.summaryTitle")}
      </Typography>

      {/* What the skill is for, read at the moment the user decides whether to
          keep it rather than while they are checking the steps. */}
      {data.purpose && (
        <Typography
          variant="body-medium-lighter"
          as="p"
          className="mt-1.5 text-[color:var(--content-quiet)]"
        >
          {data.purpose}
        </Typography>
      )}

      <div className="mt-6">
        {trigger && (
          <ListRow
            title={t("watchRetroSurface.summarySay")}
            trailing={
              <Typography variant="body-medium-default">
                {answers[trigger.id]?.answer ||
                  t("watchRetroSurface.summaryUnanswered")}
              </Typography>
            }
            disabled={disabled}
            onClick={() => {
              onEdit(triggerIndex + 1);
            }}
          />
        )}

        <ListRow
          title={t("watchRetroSurface.summarySteps")}
          trailing={
            <Typography variant="body-medium-default">
              {t("watchRetroSurface.stepCount", { count: data.steps.length })}
            </Typography>
          }
          disabled={disabled}
          onClick={() => {
            onEdit(0);
          }}
        />

        {questions.map((question, index) =>
          question.kind === "fill" ? null : (
            <ListRow
              key={question.id}
              // The eyebrow is the short name for what the question settled,
              // which is what a summary line wants. The prompt is the fallback,
              // and it is a sentence, so it truncates to one line.
              title={question.eyebrow ?? question.prompt}
              trailing={
                <Typography variant="body-medium-default">
                  {answers[question.id]?.answer ||
                    t("watchRetroSurface.summaryUnanswered")}
                </Typography>
              }
              disabled={disabled}
              onClick={() => {
                onEdit(index + 1);
              }}
            />
          ),
        )}
      </div>
    </div>
  );
}

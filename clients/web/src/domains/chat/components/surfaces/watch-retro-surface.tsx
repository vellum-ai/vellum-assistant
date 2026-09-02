import {
  type WatchRetroQuestion,
  type WatchRetroSurfaceData,
  WatchRetroSurfaceDataSchema,
} from "@vellumai/assistant-api";
import { Button, Input } from "@vellumai/design-library";
import { Eye, Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { PageProgress } from "@/domains/chat/components/surfaces/page-progress";
import type { Surface } from "@/domains/chat/types/types";
import { useTranslation } from "@/i18n";
import { cn } from "@/utils/misc";

/**
 * The end of a Watch (teach mode) session: what the assistant saw, and the few
 * things the recording could not settle.
 *
 * **One thing per page.** Page one is the record. Every question after it gets
 * a page of its own, so the card is short enough to read at a glance and the
 * questions are never a list to work through.
 *
 * **A `card` template rather than a surface type.** `CardSurface` routes here
 * on `data.template`, so a renderer that predates the template still draws the
 * surface's `title`, `subtitle` and `body` instead of an unsupported-surface
 * notice. The retro is the whole of what a finished session gives the user and
 * the turn writes no prose beside it, so it has to survive a client older than
 * this file.
 *
 * **The record leads, and the paging is what allows that.** A question on its
 * own page is not competing with the steps for attention, and the record is
 * what a user needs in order to answer anything else. The two go together: the
 * questions may only sit behind the record for as long as they have pages of
 * their own.
 *
 * **Every page is skippable and every skip is safe.** Skipping advances with a
 * default already in hand, so a user who taps through without reading still
 * lands on an answer the model can build from. `defaultAnswerFor` owns which
 * default: the first option, which the payload contract requires to be the
 * cautious answer on a gate and the model's own reading on a pick.
 *
 * **One submission, at the end.** Answers accumulate in local state and go out
 * as a single action payload rather than one turn per question. The surface is
 * registered one-shot daemon-side, so that first action is also its last.
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
 * acceptance rather than a blank. A `pick` and a `gate` start on their first
 * option: the payload contract puts the model's reading first on a pick and the
 * cautious answer first on a gate, so this one rule covers both without the
 * renderer having to know which is which.
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
 * so a repeated one would collapse two pages into a single slot: answering
 * either would overwrite the other, and both questions would submit whichever
 * answer landed last. Nothing upstream guarantees they are distinct, so the
 * first use of an id wins and later claimants are dropped, the same way an
 * unanswerable question is.
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
  const [answers, setAnswers] = useState<Record<string, WatchRetroAnswer>>(() =>
    Object.fromEntries(
      questions.map((question) => [question.id, defaultAnswerFor(question)]),
    ),
  );

  // Page 0 is the record; every page after it is one question.
  const totalPages = questions.length + 1;
  const isLastPage = pageIndex >= totalPages - 1;
  const currentQuestion = pageIndex === 0 ? null : questions[pageIndex - 1];

  const submit = useCallback(
    async (actionId: string, collected: Record<string, WatchRetroAnswer>) => {
      if (submitting) {
        return;
      }
      setSubmitting(true);
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
        });
      } finally {
        // Released unconditionally, matching `SurfaceContainer`. A rejection is
        // not the signal a failure arrives on: `handleSurfaceAction` reports a
        // failed submit to the user and returns normally, so a reset that only
        // ran on a thrown error would leave every control on the card disabled
        // after a dropped request, with the composer still blocked behind an
        // interactive surface nobody can answer. On the success path the
        // surface completes and the card is replaced, so the reset is unseen.
        setSubmitting(false);
      }
    },
    [onAction, questions, submitting, surface.surfaceId],
  );

  const advance = useCallback(
    (next: Record<string, WatchRetroAnswer>, actionId: string) => {
      setAnswers(next);
      if (isLastPage) {
        void submit(actionId, next);
        return;
      }
      setPageIndex((prev) => prev + 1);
    },
    [isLastPage, submit],
  );

  /** Record an answer and move on. A tap on an option is both, in one gesture. */
  const answerAndAdvance = useCallback(
    (question: WatchRetroQuestion, answer: WatchRetroAnswer) => {
      advance({ ...answers, [question.id]: answer }, "answer");
    },
    [advance, answers],
  );

  const skip = useCallback(() => {
    // The default is already in `answers`, so a skip only has to move on. It is
    // recorded as skipped so the model can tell an accepted default from a
    // chosen one.
    advance(answers, "skip");
  }, [advance, answers]);

  const heading = data.task || t("watchRetroSurface.untitledTask");
  const onRecord = currentQuestion === null || currentQuestion === undefined;

  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] p-4">
      {totalPages > 1 && (
        <PageProgress current={pageIndex} total={totalPages} />
      )}

      {onRecord ? (
        <RecordPage data={data} heading={heading} />
      ) : (
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

      <div className="mt-4 flex items-center gap-2">
        {/* A `pick` and a `gate` commit on tap, matching every other
            single-select surface in the app, so their page carries no advance
            button. The record and a `fill` have nothing to tap, so they keep
            one. */}
        {(onRecord || currentQuestion.kind === "fill") && (
          <Button
            variant="primary"
            disabled={submitting}
            leftIcon={
              submitting ? <Loader2 className="animate-spin" /> : undefined
            }
            onClick={() => {
              advance(answers, isLastPage ? "answer" : "next");
            }}
          >
            {isLastPage
              ? t("watchRetroSurface.save")
              : onRecord
                ? t("watchRetroSurface.thatsIt")
                : t("watchRetroSurface.next")}
          </Button>
        )}

        {!onRecord && (
          <Button variant="ghost" disabled={submitting} onClick={skip}>
            {t("watchRetroSurface.skip")}
          </Button>
        )}

        {/* Only on the record. A user who does not want the skill kept says so
            before answering questions about it. */}
        {onRecord && (
          <div className="ml-auto">
            <Button
              variant="ghost"
              disabled={submitting}
              onClick={() => {
                void submit("discard", answers);
              }}
            >
              {t("watchRetroSurface.discard")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Page one: the account of the session, and nothing to answer. */
function RecordPage({
  data,
  heading,
}: {
  data: WatchRetroSurfaceData;
  heading: string;
}) {
  return (
    <div>
      {data.eyebrow && (
        <div className="flex items-center gap-1.5 text-body-small-default text-[var(--content-quiet)]">
          <Eye className="h-3.5 w-3.5 shrink-0" />
          <span>{data.eyebrow}</span>
        </div>
      )}

      <div className="mt-1 text-title-small text-[var(--content-strong)]">
        {heading}
      </div>

      {data.purpose && (
        <p className="mt-1 text-body-medium-lighter text-[var(--content-quiet)]">
          {data.purpose}
        </p>
      )}

      {data.steps.length > 0 && (
        <ol className="mt-3 grid gap-1">
          {data.steps.map((step, index) => (
            <li
              key={`${index}-${step}`}
              className="grid grid-cols-[1.25rem_1fr] items-baseline gap-2"
            >
              <span className="text-right text-body-small-default tabular-nums text-[var(--content-quiet)]">
                {index + 1}
              </span>
              <span className="text-body-medium-default text-[var(--content-default)]">
                {step}
              </span>
            </li>
          ))}
        </ol>
      )}

      {/* A bounded recording says so here rather than hedging inside the steps:
          the steps are what was seen, and the gap is a fact about the session. */}
      {data.coverage && (
        <p className="mt-3 text-body-small-default text-[var(--content-quiet)]">
          {data.coverage}
        </p>
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
  const promptId = `watch-retro-q-${question.id}`;
  const selectedOptionId = answer?.optionId ?? question.options?.[0]?.id;

  return (
    <div>
      {question.eyebrow && (
        <div className="text-label-small-default uppercase tracking-wide text-[var(--content-quiet)]">
          {question.eyebrow}
        </div>
      )}

      {question.kind === "fill" ? (
        <label
          htmlFor={promptId}
          className="mt-1 block text-title-small text-[var(--content-strong)]"
        >
          {question.prompt}
        </label>
      ) : (
        <div
          id={promptId}
          className="mt-1 text-title-small text-[var(--content-strong)]"
        >
          {question.prompt}
        </div>
      )}

      {question.kind === "fill" ? (
        <div className="mt-3">
          {/* `Input` is `w-fit` by default, which sizes the box to whatever
              the suggestion happens to be and clips the rest of it. The
              trigger phrase is the one thing on this card the user types, and
              it has to be readable while they edit it. */}
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
          className="mt-3 grid gap-2"
          role="group"
          aria-labelledby={promptId}
        >
          {/* Hand-built rather than a design-library `Button`: an option is a
              full-width row carrying a label over a secondary note, which no
              button variant renders. Matches `choice-surface`, whose option
              rows have the same shape. */}
          {(question.options ?? []).map((option, index) => (
            <button
              key={option.id || `${index}-${option.label}`}
              type="button"
              disabled={disabled}
              // The first option is the standing answer until another is
              // tapped, so it is the one drawn as pressed.
              aria-pressed={selectedOptionId === option.id}
              onClick={() => {
                onPick(option.id, option.label);
              }}
              className={cn(
                "flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg p-3 text-left transition-colors disabled:cursor-default disabled:opacity-70",
                "bg-[var(--surface-overlay)] hover:bg-[var(--surface-active)]",
                selectedOptionId === option.id
                  ? "ring-1 ring-[var(--primary-base)]"
                  : "",
              )}
            >
              <span className="text-body-medium-default text-[var(--content-strong)]">
                {option.label}
              </span>
              {option.note && (
                <span className="text-body-small-default text-[var(--content-quiet)]">
                  {option.note}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

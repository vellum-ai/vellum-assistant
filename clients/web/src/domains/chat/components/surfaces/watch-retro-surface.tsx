import {
  type WatchRetroQuestion,
  type WatchRetroSurfaceData,
  WatchRetroSurfaceDataSchema,
} from "@vellumai/assistant-api";
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
 * **Paged, one thing per page.** The report this replaces was a markdown turn
 * carrying a numbered question list on top of a step-by-step account, and it
 * read as homework. Here the record is page one and each question gets a page
 * of its own, so nothing is stacked and nothing is scrolled past. The card
 * comes out roughly a third of the height the same content did in one block.
 *
 * **The record leads because paging removed the reason it could not.** In prose
 * the questions had to come first: order is the only priority axis a text turn
 * has, so a reader who scrolls past the account to reach the part that needs
 * them has been asked for more than the question was worth. A page has no
 * below. Putting the record first now costs the questions nothing, and it is
 * what the user needs in order to answer them at all.
 *
 * **Every page is skippable and every skip is safe.** Skipping is not a way to
 * abandon the card — it advances with a default already in hand, so a user who
 * taps through without reading still lands on an answer the model can build
 * from. Which default depends on the kind, and `defaultAnswerFor` owns that
 * rule: the first option always, which the payload contract requires to be the
 * cautious answer on a gate and the model's own reading on a pick.
 *
 * **One submission, at the end.** Answers accumulate in local state and go out
 * as a single action payload, rather than one turn per question. The surface is
 * registered one-shot daemon-side, so that first action is also its last.
 */

interface WatchRetroSurfaceProps {
  surface: Surface;
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
 * option — the payload contract puts the model's reading first on a pick and
 * the cautious answer first on a gate, so this one rule covers both without the
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
 * Drop questions that cannot be answered as drawn.
 *
 * A `pick` or `gate` with fewer than two options is a page with one button on
 * it, which is not a question — and the empty-options case would render a page
 * with no way off it at all. The surrounding schema is tolerant by design, so
 * the renderer is where a payload that parsed but cannot be operated gets
 * filtered. The record still renders; only the unusable page goes.
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

export function WatchRetroSurface({
  surface,
  onAction,
}: WatchRetroSurfaceProps) {
  const { t } = useTranslation("chat");

  // The wire keeps surface `data` opaque; narrow it with the canonical schema
  // (tolerant, so a real payload never fails to parse) rather than an
  // unchecked cast or a re-declared local interface.
  const data = useMemo<WatchRetroSurfaceData>(() => {
    const parsed = WatchRetroSurfaceDataSchema.safeParse(surface.data);
    return parsed.success ? parsed.data : { task: "", steps: [] };
  }, [surface.data]);

  const questions = useMemo(
    () => (data.questions ?? []).filter(isAnswerable),
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
        });
      } catch {
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
    // The default is already in `answers`, so a skip only has to move on; it is
    // recorded as skipped so the model can tell an accepted default from a
    // chosen one.
    advance(answers, "skip");
  }, [advance, answers]);

  const heading = data.task || t("watchRetroSurface.untitledTask");

  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] p-4">
      {totalPages > 1 && (
        <PageProgress current={pageIndex} total={totalPages} />
      )}

      {currentQuestion === null || currentQuestion === undefined ? (
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
            button — only the way past it. The record and a `fill` have nothing
            to tap, so they keep one. */}
        {(currentQuestion === null ||
          currentQuestion === undefined ||
          currentQuestion.kind === "fill") && (
          <button
            type="button"
            disabled={submitting}
            onClick={() => {
              advance(answers, isLastPage ? "answer" : "next");
            }}
            className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--primary-base)] px-4 py-2 text-body-medium-default text-[var(--content-inset)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {isLastPage
              ? t("watchRetroSurface.save")
              : pageIndex === 0
                ? t("watchRetroSurface.thatsIt")
                : t("watchRetroSurface.next")}
          </button>
        )}

        {currentQuestion !== null && currentQuestion !== undefined && (
          <button
            type="button"
            disabled={submitting}
            onClick={skip}
            className="cursor-pointer rounded-lg px-3 py-2 text-body-medium-default text-[var(--content-quiet)] transition-colors hover:text-[var(--content-default)] disabled:cursor-default disabled:opacity-50"
          >
            {t("watchRetroSurface.skip")}
          </button>
        )}

        {/* Only on the record. A user who does not want the skill kept says so
            before answering questions about it, not after. */}
        {(currentQuestion === null || currentQuestion === undefined) && (
          <button
            type="button"
            disabled={submitting}
            onClick={() => {
              void submit("discard", answers);
            }}
            className="ml-auto cursor-pointer rounded-lg px-3 py-2 text-body-medium-default text-[var(--content-quiet)] transition-colors hover:text-[var(--content-default)] disabled:cursor-default disabled:opacity-50"
          >
            {t("watchRetroSurface.discard")}
          </button>
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
        <input
          id={promptId}
          type="text"
          disabled={disabled}
          value={answer?.answer ?? ""}
          onChange={(event) => {
            onFillChange(event.target.value);
          }}
          className="mt-3 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--field-bg)] px-3 py-2 text-body-medium-lighter text-[var(--content-default)] focus:border-[var(--primary-base)] focus:outline-none focus:ring-1 focus:ring-[var(--primary-base)]"
        />
      ) : (
        <div
          className="mt-3 grid gap-2"
          role="group"
          aria-labelledby={promptId}
        >
          {(question.options ?? []).map((option, index) => (
            <button
              key={option.id || `${index}-${option.label}`}
              type="button"
              disabled={disabled}
              // The first option is the standing answer until another is
              // tapped, so it is the one drawn as pressed.
              aria-pressed={
                (answer?.optionId ?? question.options?.[0]?.id) === option.id
              }
              onClick={() => {
                onPick(option.id, option.label);
              }}
              className={cn(
                "flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg p-3 text-left transition-colors disabled:cursor-default disabled:opacity-70",
                "bg-[var(--surface-overlay)] hover:bg-[var(--surface-active)]",
                (answer?.optionId ?? question.options?.[0]?.id) === option.id
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

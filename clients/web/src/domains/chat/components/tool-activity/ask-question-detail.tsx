/**
 * The body for an `ask_question` call: what the assistant asked, and what the
 * user chose.
 *
 * Every question reads the same way, whatever came back: the options it
 * offered, the ones passed over drawn quietly, and the answer under them with
 * its own mark, whether that is an option, typed text, or a skip.
 *
 * It prefers the structured records the rest of the app reads. A settled
 * prompt is the `answeredQuestion` the daemon persists on the call, paired
 * with its options by `resolveAnswers`, the projection the transcript's card
 * renders. An outstanding prompt is the live entry in the interaction store,
 * the one the card above the composer draws, matched to this call by its
 * tool-use id.
 *
 * A call with neither still has to show what was asked, so it falls back to
 * the recorded input, read with `AskQuestionInputSchema` rather than by hand.
 * Three supported cases land there: a prompt recorded before the answered
 * record existed, one that timed out or was aborted (which record no
 * decision), and an outstanding prompt whose restored entries carry no
 * tool-use id to tie them back to this call.
 */

import type { ReactNode } from "react";

import { AskQuestionInputSchema } from "@vellumai/assistant-api";
import { Typography } from "@vellumai/design-library";

import { CodeBlock, SectionLabel } from "@/components/detail-primitives";
import {
  hasRenderableAnswer,
  resolveAnswers,
} from "@/domains/chat/answered-question";
import { AnsweredQuestionRow } from "@/domains/chat/components/answered-question-row";
import { QuestionRowContents } from "@/domains/chat/components/question-row-contents";
import { ToolOutputBody } from "@/domains/chat/components/tool-activity/tool-output-body";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import type { ToolActivityRendererProps } from "@/domains/chat/components/tool-activity/types";
import { useTranslation } from "@/i18n";

/** One option as it was offered. An old recorded call may name no id. */
interface OfferedOption {
  id?: string;
  label: string;
  description?: string;
}

/** A question this view can draw, from a record or from the recorded input. */
interface DrawnQuestion {
  key: string;
  question: string;
  description?: string;
  options: OfferedOption[];
}

/** The questions a recorded input carries, for a call with no record. */
function questionsFromInput(input: Record<string, unknown>): DrawnQuestion[] {
  const parsed = AskQuestionInputSchema.safeParse(input);
  if (!parsed.success) {
    return [];
  }
  const { questions, desktopHelp } = parsed.data;
  if (questions?.length) {
    return questions.map((entry, index) => ({
      key: `q${index}`,
      question: entry.question,
      description: entry.description,
      options: entry.options ?? [],
    }));
  }
  if (desktopHelp) {
    // The daemon asks this as a one-question prompt, so it reads as one here.
    return [
      {
        key: "desktop-help",
        question: desktopHelp.message,
        options: [desktopHelp.doneLabel, desktopHelp.skipLabel]
          .filter((label): label is string => Boolean(label))
          .map((label) => ({ label })),
      },
    ];
  }
  return [];
}

/** One question's text and, under it, whatever this view has to say about it. */
function QuestionBlock({
  question,
  description,
  children,
}: {
  question: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Typography
        variant="body-medium-default"
        as="p"
        className="whitespace-pre-wrap break-words text-[var(--content-default)]"
      >
        {question}
      </Typography>
      {description && (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--content-tertiary)]"
        >
          {description}
        </Typography>
      )}
      {children}
    </div>
  );
}

/**
 * The options a question offered, with the chosen one marked. Every option is
 * shown, not only the answer: what was on offer is what the model asked, and
 * reading the call means reading both.
 *
 * The same row the card above the composer draws, without its hotkey badge:
 * nothing here is pressable, so a key number would promise a shortcut that
 * does not exist.
 */
function QuestionOptions({
  options,
  chosenOptionId,
  settled,
}: {
  options: OfferedOption[];
  /** The option the user took, when they took one of them. */
  chosenOptionId?: string;
  /** Whether the question has an answer, of any kind. */
  settled: boolean;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {options.map((option) => {
        const chosen =
          chosenOptionId !== undefined && option.id === chosenOptionId;
        return (
          <li key={option.id ?? option.label} className="rounded-md p-1.5">
            <QuestionRowContents
              label={option.label}
              description={option.description}
              showCheck={false}
              // Once a question is answered the answer leads, so every option
              // reads quietly: the one taken is repeated under them with its
              // own mark, and typing or skipping takes none of them.
              muted={settled && !chosen}
            />
          </li>
        );
      })}
    </ul>
  );
}

export function AskQuestionDetail({
  detail,
  result,
  answeredQuestion,
  isRunning,
  isError,
  isDenied,
}: ToolActivityRendererProps) {
  const { t } = useTranslation("chat");
  const pending = useInteractionStore.use.pendingQuestion();
  // The store holds at most one outstanding prompt, and it is this call's only
  // when it names it: a drawer opened on an earlier question must not draw the
  // one the composer is asking now. A restored prompt carries no tool-use id,
  // and falls through to the recorded input below.
  const outstanding =
    pending?.toolUseId === detail.toolCallId ? pending.entries : undefined;

  const settled = hasRenderableAnswer(answeredQuestion);
  const answers = settled ? resolveAnswers(answeredQuestion) : [];
  const questions: DrawnQuestion[] = settled
    ? answeredQuestion.questions.map((entry) => ({
        key: entry.id,
        question: entry.question,
        description: entry.description,
        options: entry.options,
      }))
    : (outstanding?.map((entry) => ({
        key: entry.id,
        question: entry.question,
        description: entry.description,
        options: entry.options,
      })) ?? questionsFromInput(detail.input));

  // A refused prompt never reached the user: its result is the daemon's note
  // to the model, so the refusal is what it says.
  if (isDenied) {
    return (
      <ToolOutputBody text="" isDenied isRunning={false} isError={false} />
    );
  }

  const text = typeof result === "string" ? result : "";
  const state =
    isError && text ? (
      <CodeBlock text={text} tone="error" />
    ) : settled ? null : (
      <div>
        <SectionLabel>{t("toolDetailPanel.output")}</SectionLabel>
        <ToolOutputBody
          text={text}
          isRunning={isRunning}
          isDenied={false}
          isError={false}
        />
      </div>
    );

  if (questions.length === 0) {
    return state;
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <SectionLabel>
          {t("askQuestionDetail.heading", { count: questions.length })}
        </SectionLabel>
        <div className="flex flex-col gap-4">
          {questions.map((question, index) => {
            const answer = answers[index];
            // Only an id that names one of the options offered marks a row. An
            // unmatched id means the record and the options disagree, and
            // `resolveAnswers` already reads it as the answer instead.
            const recordedOptionId = settled
              ? answeredQuestion.responses.find(
                  (response) => response.questionId === question.key,
                )?.optionId
              : undefined;
            const chosenOptionId = question.options.some(
              (option) => option.id === recordedOptionId,
            )
              ? recordedOptionId
              : undefined;
            return (
              <QuestionBlock
                key={question.key}
                question={question.question}
                description={question.description}
              >
                {question.options.length > 0 && (
                  <QuestionOptions
                    options={question.options}
                    chosenOptionId={chosenOptionId}
                    settled={settled}
                  />
                )}
                {/* The answer, whatever kind it is: the option taken, the text
                    typed, or the skip. It carries its own mark, so it reads
                    the same way in all three cases. */}
                {answer && (
                  <AnsweredQuestionRow item={answer} mutedWhenSkipped={false} />
                )}
              </QuestionBlock>
            );
          })}
        </div>
      </div>
      {state}
    </div>
  );
}

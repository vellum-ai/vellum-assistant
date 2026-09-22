/**
 * The body for an `ask_question` call: what the assistant asked, and what the
 * user chose.
 *
 * It reads the structured records the rest of the app reads, never the input
 * bag the model wrote. A settled prompt is the `answeredQuestion` the daemon
 * persists on the call, paired with its options by `resolveAnswers`, the same
 * projection the transcript's answered card renders. An outstanding prompt is
 * the live entry in the interaction store, the same one the card above the
 * composer is drawn from, matched to this call by its tool-use id.
 *
 * A prompt that timed out or was aborted records no user decision and, once
 * the card is gone, has nothing to show here; its result says what happened
 * and the raw input is offered below, as for every tool.
 */

import type { QuestionEntry } from "@vellumai/assistant-api";
import { cn, Typography } from "@vellumai/design-library";

import { CodeBlock, SectionLabel } from "@/components/detail-primitives";
import {
  hasRenderableAnswer,
  resolveAnswers,
} from "@/domains/chat/answered-question";
import { AnsweredQuestionRow } from "@/domains/chat/components/answered-question-row";
import { QuestionRowContents } from "@/domains/chat/components/question-row-contents";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { ToolOutputBody } from "@/domains/chat/components/tool-activity/tool-output-body";
import type { ToolActivityRendererProps } from "@/domains/chat/components/tool-activity/types";
import { useTranslation } from "@/i18n";

/** One question's text and, under it, whatever this view has to say about it. */
function QuestionBlock({
  question,
  description,
  children,
}: {
  question: string;
  description?: string;
  children: React.ReactNode;
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
}: {
  options: QuestionEntry["options"];
  /** The option the user took, when they took one. */
  chosenOptionId?: string;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {options.map((option, index) => {
        const chosen = option.id === chosenOptionId;
        return (
          <li
            key={option.id}
            className={cn(
              "rounded-md p-1.5",
              chosen && "bg-[var(--surface-base)]",
            )}
          >
            <QuestionRowContents
              badgeNumber={index + 1}
              showBadge={false}
              label={option.label}
              description={option.description}
              showCheck={chosen}
              muted={chosenOptionId !== undefined && !chosen}
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
  // The store holds at most one outstanding prompt, which is this call's only
  // when it names it: a drawer opened on an earlier question must not draw the
  // one the composer is asking now.
  const outstanding =
    pending?.toolUseId === detail.toolCallId ? pending.entries : undefined;

  // A refused prompt never reached the user: its result is the daemon's note
  // to the model, so the refusal is what it says.
  if (isDenied) {
    return (
      <ToolOutputBody text="" isDenied isRunning={false} isError={false} />
    );
  }

  if (hasRenderableAnswer(answeredQuestion)) {
    const answers = resolveAnswers(answeredQuestion);
    return (
      <div>
        <SectionLabel>
          {answers.length === 1
            ? t("askQuestionDetail.question")
            : t("askQuestionDetail.questions")}
        </SectionLabel>
        <div className="flex flex-col gap-4">
          {answers.map((item, index) => {
            const asked = answeredQuestion.questions[index];
            const response = answeredQuestion.responses.find(
              (candidate) => candidate.questionId === item.questionId,
            );
            return (
              <QuestionBlock
                key={item.questionId}
                question={item.question}
                description={item.description}
              >
                {asked && asked.options.length > 0 && (
                  <QuestionOptions
                    options={asked.options}
                    chosenOptionId={
                      item.kind === "option" ? response?.optionId : undefined
                    }
                  />
                )}
                {/* A typed answer or a skip matched no option, so it reads as
                    its own row, the one the transcript's card draws. */}
                {item.kind !== "option" && <AnsweredQuestionRow item={item} />}
              </QuestionBlock>
            );
          })}
        </div>
      </div>
    );
  }

  if (outstanding && outstanding.length > 0) {
    return (
      <div className="flex flex-col gap-5">
        <div>
          <SectionLabel>
            {outstanding.length === 1
              ? t("askQuestionDetail.question")
              : t("askQuestionDetail.questions")}
          </SectionLabel>
          <div className="flex flex-col gap-4">
            {outstanding.map((entry) => (
              <QuestionBlock
                key={entry.id}
                question={entry.question}
                description={entry.description}
              >
                <QuestionOptions options={entry.options} />
              </QuestionBlock>
            ))}
          </div>
        </div>
        <div>
          <SectionLabel>{t("toolDetailPanel.output")}</SectionLabel>
          <ToolOutputBody text="" isRunning isDenied={false} isError={false} />
        </div>
      </div>
    );
  }

  // Nothing structured to show: a prompt that timed out or was aborted records
  // no decision, and its card is gone. The result says what happened, and the
  // raw input is offered below, as for every tool.
  const text = typeof result === "string" ? result : "";
  if (isError && text) {
    return <CodeBlock text={text} tone="error" />;
  }
  return (
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
}

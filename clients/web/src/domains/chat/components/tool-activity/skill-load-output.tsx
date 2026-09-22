/**
 * The "Output" section of a `skill_load` detail panel: the skill's instructions
 * rendered as markdown and clamped to a readable height. The verbatim result is
 * Raw output, which the drawer offers below every call.
 *
 * `skill_load`'s output is the skill body itself: markdown that reads properly
 * rendered, but that an operator sometimes needs verbatim, header lines and
 * tool manifest included.
 */

import {
  CodeBlock,
  DetailBlock,
  SectionLabel,
} from "@/components/detail-primitives";
import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { useTranslation } from "@/i18n";

export function SkillLoadOutput({
  /** Instruction markdown, header and tool manifest already stripped. */
  instructions,
  /** The tool's verbatim result, when one has landed. */
  raw,
  assistantId,
}: {
  instructions: string;
  raw: string;
  assistantId?: string | null;
}) {
  const { t } = useTranslation("chat");

  if (instructions === "" && raw === "") {
    return null;
  }

  // A skill whose body is nothing but the header and its tool manifest parses
  // to empty instructions. The verbatim result is then the whole output, and
  // leaving it to Raw output would leave the section looking empty. It draws
  // as a code block rather than the filled card the rendered instructions use,
  // because that is what it is: the body as the daemon returned it.
  return (
    <div>
      <SectionLabel>{t("toolDetailPanel.output")}</SectionLabel>
      {instructions !== "" ? (
        <DetailBlock variant="filled">
          <ChatMarkdownMessage
            content={instructions}
            assistantId={assistantId}
          />
        </DetailBlock>
      ) : (
        <CodeBlock text={raw} />
      )}
    </div>
  );
}

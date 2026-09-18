/**
 * The "Output" section of a `skill_load` detail panel: the skill's instructions
 * rendered as markdown and clamped to a readable height, with the verbatim
 * result behind the Raw output disclosure underneath, the way every tool's raw
 * data is reached.
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
import { RawDisclosure } from "@/domains/chat/components/tool-activity/raw-disclosure";
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
  // hiding it behind a disclosure would leave the section looking empty.
  const readable = instructions !== "";

  return (
    <>
      <div>
        <SectionLabel>{t("toolDetailPanel.output")}</SectionLabel>
        {readable ? (
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
      {readable && raw !== "" && (
        <RawDisclosure
          label={t("toolOutputSection.rawOutput")}
          text={() => raw}
        />
      )}
    </>
  );
}

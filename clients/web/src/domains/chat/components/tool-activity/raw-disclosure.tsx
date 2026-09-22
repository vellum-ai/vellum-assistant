/**
 * A tool call's raw input or raw output, behind a disclosure. `ToolDetailBody`
 * draws both for every call, below whatever presents the call readably, so the
 * raw data of every tool is in the same place under the same names.
 */

import { CodeBlock } from "@/components/detail-primitives";
import { DetailDisclosure } from "@/domains/chat/components/tool-activity/detail-disclosure";
import { useTranslation } from "@/i18n";

/**
 * The raw text. Its own component so the disclosure, which unmounts closed
 * content, only builds the text once someone opens it: raw JSON can run to
 * hundreds of thousands of characters for a panel that never shows it.
 */
function RawText({ text }: { text: () => string }) {
  return <CodeBlock text={text()} />;
}

export function RawDisclosure({
  side,
  text,
}: {
  /** Which side of the call the raw text is. */
  side: "input" | "output";
  /** The raw text, built only when the disclosure opens. */
  text: () => string;
}) {
  const { t } = useTranslation("chat");
  return (
    <DetailDisclosure
      label={
        side === "input" ? t("rawDisclosure.input") : t("rawDisclosure.output")
      }
    >
      {/* No name passed to the fold inside: the disclosure is a Radix
          accordion, whose content is already a region named by this label, and
          a second region of the same name nested in it names it twice. */}
      <RawText text={text} />
    </DetailDisclosure>
  );
}

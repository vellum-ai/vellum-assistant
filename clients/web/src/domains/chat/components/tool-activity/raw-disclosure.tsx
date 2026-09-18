/**
 * A tool's raw data, behind a disclosure under the readable view of it. The
 * input, the output and every renderer that draws its own output show raw data
 * through this one control, so a reader finds it in the same place for every
 * tool.
 */

import { CodeBlock } from "@/components/detail-primitives";
import { DetailDisclosure } from "@/domains/chat/components/tool-activity/detail-disclosure";

/**
 * The raw text. Its own component so the disclosure, which unmounts closed
 * content, only builds the text once someone opens it: raw JSON can run to
 * hundreds of thousands of characters for a panel that never shows it.
 */
function RawText({ text }: { text: () => string }) {
  return <CodeBlock text={text()} />;
}

export function RawDisclosure({
  label,
  text,
}: {
  /** The disclosure's label, e.g. "Raw input". */
  label: string;
  /** The raw text, built only when the disclosure opens. */
  text: () => string;
}) {
  return (
    <DetailDisclosure label={label}>
      <RawText text={text} />
    </DetailDisclosure>
  );
}

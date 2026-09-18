/**
 * A tool detail section that lays a value out as fields, with the value's raw
 * form behind a disclosure underneath. A tool's input and its structured
 * output are both drawn this way, so a reader learns one shape for both.
 */

import { CodeBlock, SectionLabel } from "@/components/detail-primitives";
import { DetailDisclosure } from "@/domains/chat/components/tool-activity/detail-disclosure";
import { ValueFields } from "@/domains/chat/components/tool-activity/value-fields";
import type { ValueFieldList } from "@/domains/chat/utils/value-layout";

/**
 * The raw form. Its own component so the disclosure, which unmounts closed
 * content, only builds the text once someone opens it.
 */
function RawText({ text }: { text: () => string }) {
  return <CodeBlock text={text()} />;
}

interface ValueSectionProps {
  /** The section's uppercase label, e.g. "Parameters". */
  label: string;
  /** The value laid out as fields, or `null` to draw only the raw form. */
  list: ValueFieldList | null;
  /** The sentence counting what the layout left out, naming the raw form. */
  moreLabel: (count: number) => string;
  /** The disclosure's label, e.g. "Raw input". */
  rawLabel: string;
  /** The raw form's text, built only when the disclosure opens. */
  rawText: () => string;
}

export function ValueSection({
  label,
  list,
  moreLabel,
  rawLabel,
  rawText,
}: ValueSectionProps) {
  return (
    <>
      {list && (
        <div>
          <SectionLabel>{label}</SectionLabel>
          <ValueFields list={list} moreLabel={moreLabel} />
        </div>
      )}
      <DetailDisclosure label={rawLabel}>
        <RawText text={rawText} />
      </DetailDisclosure>
    </>
  );
}

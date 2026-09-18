/**
 * A tool detail section that lays a value out as fields, with the value's raw
 * form behind a disclosure underneath. A tool's input and its structured
 * output are both drawn this way, so a reader learns one shape for both.
 */

import { SectionLabel } from "@/components/detail-primitives";
import { RawDisclosure } from "@/domains/chat/components/tool-activity/raw-disclosure";
import { ValueFields } from "@/domains/chat/components/tool-activity/value-fields";
import type { ValueFieldList } from "@/domains/chat/utils/value-layout";

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
          <ValueFields list={list} moreLabel={moreLabel} label={label} />
        </div>
      )}
      <RawDisclosure label={rawLabel} text={rawText} />
    </>
  );
}

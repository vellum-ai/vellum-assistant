/**
 * A tool detail section that lays a value out as labelled fields. A tool's
 * input and its structured output are both drawn this way, so a reader learns
 * one shape for both; their raw forms sit below, in `ToolDetailBody`.
 */

import { SectionLabel } from "@/components/detail-primitives";
import { ValueFields } from "@/domains/chat/components/tool-activity/value-fields";
import type { ValueFieldList } from "@/domains/chat/utils/value-layout";

interface ValueSectionProps {
  /** The section's uppercase label, e.g. "Parameters". */
  label: string;
  /** The value laid out as fields. */
  list: ValueFieldList;
  /** The sentence counting what the layout left out, naming the raw form. */
  moreLabel: (count: number) => string;
}

export function ValueSection({ label, list, moreLabel }: ValueSectionProps) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <ValueFields list={list} moreLabel={moreLabel} label={label} />
    </div>
  );
}

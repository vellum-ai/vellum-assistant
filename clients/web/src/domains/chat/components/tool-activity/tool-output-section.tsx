/**
 * The Output section of a tool detail, laid out the way its input is: a
 * result that is a JSON object or array draws as fields and tables. Any other
 * result, and every state before or instead of a result (running, refused,
 * failed, empty), reads through `ToolOutputBody` as before. The result exactly
 * as received is offered by `ToolDetailBody` as Raw output, below the section.
 *
 * Only a completed call's result is laid out. Streamed output is a partial
 * tail, and an error reads as the error text it is, whatever its shape.
 */

import { useMemo } from "react";

import { SectionLabel } from "@/components/detail-primitives";
import { ToolOutputBody } from "@/domains/chat/components/tool-activity/tool-output-body";
import { ValueSection } from "@/domains/chat/components/tool-activity/value-section";
import {
  layoutResult,
  parseStructuredResult,
  type ValueFieldList,
} from "@/domains/chat/utils/value-layout";
import { useTranslation } from "@/i18n";

/**
 * The fields a completed result lays out to, or `null` when it reads as text.
 * A result can run to 400,000 characters, so it is parsed and laid out once
 * per result rather than on every render of a panel that re-renders as the
 * turn does.
 */
export function useResultLayout(
  result: string | undefined,
  settled: boolean,
): ValueFieldList | null {
  return useMemo(() => {
    const structured = settled && result ? parseStructuredResult(result) : null;
    return structured ? layoutResult(structured) : null;
  }, [settled, result]);
}

interface ToolOutputSectionProps {
  /** The final result, or `undefined` while the call has not produced one. */
  result: string | undefined;
  /** The result laid out as fields, from `useResultLayout`, or `null`. */
  layout: ValueFieldList | null;
  /** The live tail while the call is still running. */
  streamedOutput: string | undefined;
  isDenied: boolean;
  isRunning: boolean;
  isError: boolean;
}

export function ToolOutputSection({
  result,
  layout,
  streamedOutput,
  isDenied,
  isRunning,
  isError,
}: ToolOutputSectionProps) {
  const { t } = useTranslation("chat");

  if (layout) {
    return (
      <ValueSection
        label={t("toolDetailPanel.output")}
        list={layout}
        moreLabel={(count) => t("toolOutputSection.moreCount", { count })}
      />
    );
  }

  return (
    <div>
      <SectionLabel>{t("toolDetailPanel.output")}</SectionLabel>
      <ToolOutputBody
        text={result ? result : (streamedOutput ?? "")}
        isDenied={isDenied}
        isRunning={isRunning}
        isError={isError}
      />
    </div>
  );
}

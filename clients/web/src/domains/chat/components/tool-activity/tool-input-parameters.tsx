/**
 * What a tool call was given, in a detail panel: its parameters as labelled
 * fields, and the raw input one disclosure away for anything the fields leave
 * out.
 *
 * Renders the two as siblings rather than inside a wrapper, so the caller's
 * column spaces them like the rest of its sections. With no parameters there
 * are no fields, and the raw input stands alone.
 */

import { ValueSection } from "@/domains/chat/components/tool-activity/value-section";
import { jsonText, layoutValues } from "@/domains/chat/utils/value-layout";
import { useTranslation } from "@/i18n";

interface ToolInputParametersProps {
  /** Parameters to show, in insertion order. */
  params: Record<string, unknown>;
  /** The input exactly as the call carried it, shown as JSON on request. */
  rawInput: Record<string, unknown>;
}

export function ToolInputParameters({
  params,
  rawInput,
}: ToolInputParametersProps) {
  const { t } = useTranslation("chat");

  return (
    <ValueSection
      label={t("toolInputParameters.parameters")}
      list={Object.keys(params).length > 0 ? layoutValues(params) : null}
      moreLabel={(count) => t("toolInputParameters.moreCount", { count })}
      rawLabel={t("toolInputParameters.rawInput")}
      rawText={() => jsonText(rawInput)}
    />
  );
}

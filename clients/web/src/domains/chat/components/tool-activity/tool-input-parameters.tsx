/**
 * What a tool call was given, in a detail panel: its parameters as labelled
 * fields. With no parameters there is nothing to lay out and it draws nothing;
 * the input exactly as sent is Raw input, below every call.
 */

import { ValueSection } from "@/domains/chat/components/tool-activity/value-section";
import { layoutValues } from "@/domains/chat/utils/value-layout";
import { useTranslation } from "@/i18n";

interface ToolInputParametersProps {
  /** Parameters to show, in insertion order. */
  params: Record<string, unknown>;
}

export function ToolInputParameters({ params }: ToolInputParametersProps) {
  const { t } = useTranslation("chat");

  if (Object.keys(params).length === 0) {
    return null;
  }
  return (
    <ValueSection
      label={t("toolInputParameters.parameters")}
      list={layoutValues(params)}
      moreLabel={(count) => t("toolInputParameters.moreCount", { count })}
    />
  );
}

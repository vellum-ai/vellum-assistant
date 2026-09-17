/**
 * What a tool call was given, in a detail panel: its parameters as labelled
 * fields, and the raw input one disclosure away for anything the fields leave
 * out.
 *
 * Renders the two as siblings rather than inside a wrapper, so the caller's
 * column spaces them like the rest of its sections. With no parameters there
 * are no fields, and the raw input stands alone.
 */

import { CodeBlock, SectionLabel } from "@/components/detail-primitives";
import { DetailDisclosure } from "@/domains/chat/components/tool-activity/detail-disclosure";
import { ToolParamFields } from "@/domains/chat/components/tool-activity/tool-param-fields";
import { jsonText, layoutValues } from "@/domains/chat/utils/value-layout";
import { useTranslation } from "@/i18n";

/**
 * The raw input as pretty JSON. Its own component so the disclosure, which
 * unmounts closed content, only serializes the input once someone opens it.
 */
function RawInputJson({ input }: { input: Record<string, unknown> }) {
  return <CodeBlock text={jsonText(input)} />;
}

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
    <>
      {Object.keys(params).length > 0 && (
        <div>
          <SectionLabel>{t("toolInputParameters.parameters")}</SectionLabel>
          <div className="rounded-lg border border-[var(--border-base)] p-4">
            <ToolParamFields list={layoutValues(params)} />
          </div>
        </div>
      )}

      <DetailDisclosure label={t("toolInputParameters.rawInput")}>
        <RawInputJson input={rawInput} />
      </DetailDisclosure>
    </>
  );
}

/**
 * What a tool call was given, in a detail panel: its parameters as labelled
 * rows, and the raw input one disclosure away for anything the rows leave out.
 *
 * Renders the two as siblings rather than inside a wrapper, so the caller's
 * column spaces them like the rest of its sections. With no parameters there
 * are no rows, and the raw input stands alone.
 */

import { CodeBlock, SectionLabel } from "@/components/detail-primitives";
import { DetailDisclosure } from "@/domains/chat/components/tool-activity/detail-disclosure";
import { ToolParamRow } from "@/domains/chat/components/tool-activity/tool-param-row";
import type { ToolParam } from "@/domains/chat/utils/tool-params";
import { useTranslation } from "@/i18n";

interface ToolInputParametersProps {
  /** Rows to show, in order. */
  params: ToolParam[];
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
      {params.length > 0 && (
        <div>
          <SectionLabel>{t("toolInputParameters.parameters")}</SectionLabel>
          <div className="flex flex-col gap-4 rounded-lg border border-[var(--border-base)] p-4">
            {params.map((param) => (
              <ToolParamRow key={param.key} param={param} />
            ))}
          </div>
        </div>
      )}

      <DetailDisclosure label={t("toolInputParameters.rawInput")}>
        <CodeBlock text={JSON.stringify(rawInput, null, 2)} />
      </DetailDisclosure>
    </>
  );
}

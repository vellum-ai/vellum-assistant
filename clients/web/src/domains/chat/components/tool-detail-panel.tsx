import { useTranslation } from "@/i18n";
/**
 * Side-drawer body shown when a tool-call step pill is clicked. Mirrors the
 * web `SubagentDetailPanel` shell (outer container, header with leading icon /
 * title / close, scrollable body with sections). The call's risk level lives
 * in the body's "Risk Level" section (badge + tolerance hint), not the
 * header.
 *
 * Driven by the `ToolDetailPayload` opened into `viewer-store`. Both variants
 * subscribe to the chat-session store so an open drawer streams live: the tool
 * variant mirrors `tool_output_chunk` output and the final result via
 * `useLiveToolCall` (see `ToolDetailBody`), the thinking variant the reasoning
 * text via `useLiveThinkingText` (see `ThinkingDetailBody`).
 */

import { Bolt, Brain } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import { DetailShell } from "@/components/detail-shell";
import { RiskChip } from "@/domains/chat/components/risk-chip";
import { ThinkingDetailMarkdown } from "@/domains/chat/components/thinking-detail-markdown";
import { friendlyName } from "@/domains/chat/components/tool-call-chip/utils";
import { ToolOutputSection } from "@/domains/chat/components/tool-activity/tool-output-section";
import { getToolActivityRenderer } from "@/domains/chat/components/tool-activity/tool-activity-renderers";
import {
  TRANSCRIPT_TOOL_CALL_SOURCE,
  useLiveToolCall,
  type ToolCallSource,
} from "@/domains/chat/hooks/use-live-tool-call";
import { deriveStepLabelFromName } from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { ICON_MAP } from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import {
  isToolCallDenied,
  isToolCallRunning,
} from "@/domains/chat/utils/tool-call-status";
import { ToolInputParameters } from "@/domains/chat/components/tool-activity/tool-input-parameters";
import { toolCallParams } from "@/domains/chat/utils/tool-input";
import type { ToolDetailPayload } from "@/stores/viewer-store";

/**
 * Thinking variant body. Reuses the shared shell around the live reasoning
 * markdown (see `ThinkingDetailMarkdown`).
 */
function ThinkingDetailBody({
  detail,
  onClose,
  assistantId,
}: {
  detail: ToolDetailPayload;
  onClose: () => void;
  assistantId?: string | null;
}) {
  const { t } = useTranslation("chat");
  return (
    <DetailShell
      Glyph={Brain}
      title={detail.title}
      closeLabel={t("toolDetailPanel.closeAria")}
      closeVariant="outlined"
      onClose={onClose}
    >
      <ThinkingDetailMarkdown detail={detail} assistantId={assistantId} />
    </DetailShell>
  );
}

/**
 * The body of a tool detail: whatever the tool's registered renderer shows, or
 * the generic parameter and Output sections when it has none. No shell,
 * header or close button, so every panel that hosts a tool call frames it its
 * own way: `ToolDetailPanel`, `ActivityStepsPanel` and `SubagentDetailPanel`
 * all compose this, which is what makes a call read the same wherever it is
 * opened.
 *
 * The tool that ran and its risk level belong to `ToolDetailHeaderTitle`, so
 * nothing here repeats them.
 *
 * Reads the call from its `source` via `useLiveToolCall` so an open drawer
 * streams `tool_output_chunk` output while the call runs and flips to the final
 * `result` when it lands, falling back to the open-time snapshot on `detail`
 * when the call can't be resolved live (e.g. paged out).
 */
export function ToolDetailBody({
  detail,
  source,
  assistantId,
}: {
  detail: ToolDetailPayload;
  /** Where the call lives, so the body reads it live. */
  source: ToolCallSource;
  /** Threaded to any markdown a tool-specific renderer shows. */
  assistantId?: string | null;
}) {
  const liveTc = useLiveToolCall(source, detail.toolCallId);
  const result = liveTc?.result ?? detail.result;
  const streamedOutput = liveTc?.streamedOutput ?? detail.streamedOutput;

  const isRunning = liveTc
    ? isToolCallRunning(liveTc)
    : detail.status === "running";
  const isError = liveTc?.isError ?? detail.status === "error";
  // Live, like the two flags above: the decision can be stamped on the
  // transcript while this drawer is open. `isToolCallDenied` covers a prompt
  // that expired as well as one refused, so the copy below is true of both.
  const isDenied = liveTc
    ? isToolCallDenied(liveTc)
    : detail.status === "denied";

  // Tools with purpose-built activity UI replace the generic parameters; those
  // that also own their output suppress the shared Output section.
  const renderer = getToolActivityRenderer(detail);

  return (
    <>
      {/* Tool-specific body when the tool has one, else the call's parameters
          with its raw input behind a disclosure. The header names the tool and
          shows its risk, so neither is repeated here. */}
      {renderer ? (
        <renderer.Component
          detail={detail}
          result={result}
          streamedOutput={streamedOutput}
          isRunning={isRunning}
          isError={isError}
          isDenied={isDenied}
          assistantId={assistantId}
        />
      ) : (
        <div className="flex flex-col gap-5">
          <ToolInputParameters
            params={toolCallParams(detail.input)}
            rawInput={detail.input}
          />
        </div>
      )}

      {/* Output, laid out like the input when the result is structured.
          Suppressed for tools whose renderer already presents the result. */}
      {!renderer?.ownsOutput && (
        <div className="mt-5 flex flex-col gap-5">
          <ToolOutputSection
            result={result}
            streamedOutput={streamedOutput}
            isDenied={isDenied}
            isRunning={isRunning}
            isError={isError}
          />
        </div>
      )}
    </>
  );
}

/**
 * Title the panel hosting a tool detail shows for it: the activity sentence
 * when the call carries one, else the phase title.
 *
 * Every host of `ToolDetailBody` renders its own header, and the body relies on
 * all of them showing this, which is why the body itself does not repeat the
 * activity underneath the tool name.
 */
export function toolDetailHeaderTitle(detail: ToolDetailPayload): string {
  // The activity sentence is written by the model, so it can carry newlines or
  // runs of spaces that a single-line header would render as gaps. Collapse
  // them here rather than at each of the three panels that show it.
  return (detail.activity || detail.title).replace(/\s+/g, " ").trim();
}

/**
 * Header title for a tool detail: the activity sentence, and under it the tool
 * that ran with its risk level.
 *
 * Shared by every panel that hosts a `ToolDetailBody` so a call is headed the
 * same way wherever it is opened, and so the body never has to repeat any of
 * it. The sentence wraps to two lines rather than truncating on one, because
 * most activity sentences are longer than a single line at the drawer's
 * default width; the native tooltip carries the tail of the rest.
 */
export function ToolDetailHeaderTitle({
  detail,
  source,
}: {
  detail: ToolDetailPayload;
  /** Where the call lives, so the risk level reads live. */
  source: ToolCallSource;
}) {
  // Risk is classified asynchronously and can land after the drawer opens, so
  // read it live and fall back to the open-time snapshot. The raw `riskReason`
  // rule-match string ("ls (default)") is classifier jargon and stays hidden.
  const liveTc = useLiveToolCall(source, detail.toolCallId);
  const riskLevel = liveTc?.riskLevel ?? detail.riskLevel;
  const title = toolDetailHeaderTitle(detail);
  return (
    <div className="min-w-0 py-0.5">
      <Typography
        variant="title-medium"
        as="div"
        title={title}
        className="line-clamp-2 leading-snug text-[var(--content-default)]"
      >
        {title}
      </Typography>
      {/* Wraps rather than competing for one line. Where the device cannot
          hover, `RiskChip` renders the tolerance sentence as a second sibling
          here, and on one line that sentence takes the space the tool name
          needs: at the drawer's width "Edit File" came out as "Edit...". The
          tool that ran is the thing this row exists to name, so the sentence
          moves to its own line instead. */}
      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <Typography
          variant="body-small-lighter"
          as="span"
          className="shrink-0 truncate text-[var(--content-tertiary)]"
        >
          {friendlyName(detail.toolName)}
        </Typography>
        <RiskChip level={riskLevel} />
      </div>
    </div>
  );
}

export function ToolDetailPanel({
  detail,
  onClose,
  assistantId,
}: {
  detail: ToolDetailPayload;
  onClose: () => void;
  /**
   * Assistant that owns the conversation the step belongs to. Threaded to the
   * reasoning markdown so a workspace file the model named resolves against
   * the right workspace.
   */
  assistantId?: string | null;
}) {
  const { t } = useTranslation("chat");
  // Thinking variant: reuse the same shell/header but render the full
  // reasoning markdown with no input/output sections and no risk badge.
  if (detail.kind === "thinking") {
    return (
      <ThinkingDetailBody
        detail={detail}
        onClose={onClose}
        assistantId={assistantId}
      />
    );
  }

  const { iconName } = deriveStepLabelFromName(detail.toolName, detail.input);
  const Glyph = ICON_MAP[iconName] ?? Bolt;

  return (
    <DetailShell
      Glyph={Glyph}
      titleNode={
        <ToolDetailHeaderTitle
          detail={detail}
          source={TRANSCRIPT_TOOL_CALL_SOURCE}
        />
      }
      closeLabel={t("toolDetailPanel.closeAria")}
      // Bordered X, matching the Figma sidepanel header and the sibling
      // background-task / settings drawers.
      closeVariant="outlined"
      onClose={onClose}
    >
      <ToolDetailBody
        detail={detail}
        source={TRANSCRIPT_TOOL_CALL_SOURCE}
        assistantId={assistantId}
      />
    </DetailShell>
  );
}

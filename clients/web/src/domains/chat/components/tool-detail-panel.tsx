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

import {
  Bolt,
  Brain,
  Code,
  FileText,
  Globe,
  Monitor,
  Pen,
  Plug,
  Sparkles,
  SquareTerminal,
  UserPlus,
  type LucideIcon,
} from "lucide-react";

import { Notice, Typography } from "@vellumai/design-library";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { CodeBlock, SectionLabel } from "@/components/detail-primitives";
import { DetailShell } from "@/components/detail-shell";
import { getToolActivityRenderer } from "@/domains/chat/components/tool-activity/tool-activity-renderers";
import { titleCaseToolName } from "@/domains/chat/components/tool-call-chip/utils";
import { useLiveThinkingText } from "@/domains/chat/hooks/use-live-thinking-text";
import { useLiveToolCall } from "@/domains/chat/hooks/use-live-tool-call";
import {
  deriveStepLabelFromName,
  type IconName,
} from "@/domains/chat/components/tool-progress-card/derive-step-label";
import {
  getRiskBadgeWeakStyle,
  getRiskNoticeTone,
  getRiskToleranceHint,
} from "@/domains/chat/utils/risk";
import {
  isToolCallDenied,
  isToolCallRunning,
} from "@/domains/chat/utils/tool-call-status";
import type { ToolDetailPayload } from "@/stores/viewer-store";

/**
 * Concrete lucide icon for each `IconName` produced by `deriveStepLabel`.
 * Local copy of the map used by `phase-grouped-step-list` so this panel picks
 * a matching header glyph without importing card internals.
 */
const ICON_MAP: Record<IconName, LucideIcon> = {
  code: Code,
  terminal: SquareTerminal,
  file: FileText,
  globe: Globe,
  pen: Pen,
  monitor: Monitor,
  plug: Plug,
  sparkle: Sparkles,
  "user-plus": UserPlus,
  bolt: Bolt,
  brain: Brain,
};

/**
 * Thinking variant body. Reuses the shared shell but renders the reasoning
 * markdown live: it re-derives the text from the chat-session store via the
 * payload's stable identity so an open drawer streams as deltas land, falling
 * back to the open-time `thinkingText` snapshot when the source can't be
 * resolved (e.g. message paged out, or an identity-less payload).
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
  const live = useLiveThinkingText(
    detail.messageId,
    detail.thinkingGroupIndex,
    detail.thinkingItemIndex,
  );
  return (
    <DetailShell
      Glyph={Brain}
      title={detail.title}
      closeLabel={t("toolDetailPanel.closeAria")}
      closeVariant="outlined"
      onClose={onClose}
    >
      <ChatMarkdownMessage
        content={live ?? detail.thinkingText ?? ""}
        hardLineBreaks
        assistantId={assistantId}
      />
    </DetailShell>
  );
}

/**
 * Tool-variant detail sections — the tool name, activity, input `CodeBlock`,
 * and "Output" — with no surrounding shell, header, or close button. Composed
 * by `ToolDetailPanel` inside its own `DetailShell`, and reused by
 * `SubagentDetailPanel` to show a nested tool call under the subagent's own
 * header.
 *
 * Subscribes to the chat-session store via `useLiveToolCall` so an open drawer
 * streams `tool_output_chunk` output while the call runs and flips to the final
 * `result` when it lands, falling back to the open-time snapshot on `detail`
 * when the call can't be resolved live (e.g. paged out).
 */
export function ToolDetailBody({
  detail,
  assistantId,
}: {
  detail: ToolDetailPayload;
  /** Threaded to any markdown a tool-specific renderer shows. */
  assistantId?: string | null;
}) {
  const { t } = useTranslation("chat");
  const liveTc = useLiveToolCall(detail.toolCallId);
  const result = liveTc?.result ?? detail.result;
  const streamedOutput = liveTc?.streamedOutput ?? detail.streamedOutput;

  // An empty string is a result: the tool ran and returned nothing. Only an
  // absent result means the call has not produced one yet.
  const hasResult = result !== undefined;
  const isEmptyResult = result === "";
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
  const hasStreamedOutput = !!streamedOutput;
  const inputJson = JSON.stringify(detail.input, null, 2);

  // Risk assessment can land after the drawer opens — prefer the live call.
  // The raw `riskReason` rule-match string ("ls (default)") is internal
  // classifier jargon and is deliberately NOT shown.
  const riskLevel = liveTc?.riskLevel ?? detail.riskLevel;
  const riskHint = getRiskToleranceHint(riskLevel);
  const riskStyle = getRiskBadgeWeakStyle(riskLevel);

  // What the Output section says when it has no text to show. Every terminal
  // call that produced nothing lands on `emptyOutput`, including one that was
  // force-completed with no result at all, so the section always answers "what
  // came back" rather than disappearing.
  const outputNoticeKey =
    isDenied && !hasResult
      ? "toolDetailPanel.denied"
      : isRunning
        ? "toolDetailPanel.running"
        : "toolDetailPanel.emptyOutput";

  // Tools with purpose-built activity UI replace the generic name/activity/JSON
  // block; those that also own their output suppress the shared Output section.
  const renderer = getToolActivityRenderer(detail);

  return (
    <>
      {/* Risk Level — a single tone-coloured bar reading "<level> →
          <when it auto-approves>" (Figma node 7778-163402). The level and its
          tolerance hint were previously a badge stacked over a caption in a
          neutral card, which spent three lines saying one thing. */}
      {riskLevel && (
        <div className="mb-5">
          <SectionLabel>{t("toolDetailPanel.riskLevel")}</SectionLabel>
          <Notice
            tone={getRiskNoticeTone(riskLevel)}
            data-testid="risk-notice"
            data-risk-level={riskLevel}
          >
            {/* `Notice` renders its message in `--content-secondary`; the
                colour class on this span applies directly to the text and so
                beats the inherited value, giving the Figma's tone-matched
                sentence without a design-library fork. */}
            <span className={riskStyle.text}>
              {riskHint ? `${riskStyle.label} → ${riskHint}` : riskStyle.label}
            </span>
          </Notice>
        </div>
      )}

      {/* Tool-specific activity UI when the tool has one, else the generic
          name + activity + raw JSON input block. */}
      {renderer ? (
        <renderer.Component
          detail={detail}
          result={result}
          streamedOutput={streamedOutput}
          isRunning={isRunning}
          isError={isError}
          assistantId={assistantId}
        />
      ) : (
        <div>
          <Typography
            variant="body-medium-default"
            as="div"
            className="text-[var(--content-default)]"
          >
            {titleCaseToolName(detail.toolName)}
          </Typography>
          <div className="mt-2">
            <CodeBlock text={inputJson} />
          </div>
        </div>
      )}

      {/* Output — the final result once present, else the live streamed tail
          while running, else a bare running placeholder. Suppressed for tools
          whose renderer already presents the result itself. */}
      {!renderer?.ownsOutput && (
        <div className="mt-5">
          <SectionLabel>{t("toolDetailPanel.output")}</SectionLabel>
          {hasResult && !isEmptyResult ? (
            <CodeBlock
              text={result as string}
              tone={isError ? "error" : "default"}
            />
          ) : hasStreamedOutput ? (
            <CodeBlock text={streamedOutput as string} />
          ) : (
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-tertiary)]"
              data-testid="tool-output-notice"
            >
              {t(outputNoticeKey)}
            </Typography>
          )}
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
  // Thinking variant — reuse the same shell/header but render the full
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

  const title = toolDetailHeaderTitle(detail);

  return (
    <DetailShell
      Glyph={Glyph}
      title={title}
      closeLabel={t("toolDetailPanel.closeAria")}
      // Bordered X, matching the Figma sidepanel header and the sibling
      // background-task / settings drawers.
      closeVariant="outlined"
      onClose={onClose}
    >
      <ToolDetailBody detail={detail} assistantId={assistantId} />
    </DetailShell>
  );
}

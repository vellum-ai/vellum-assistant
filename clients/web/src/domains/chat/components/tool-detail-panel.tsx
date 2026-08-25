
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
import { isToolCallRunning } from "@/domains/chat/utils/tool-call-status";
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

// Re-exported for the panels that already imported these from here
// (`background-task-detail-panel`, `acp-run-detail-panel`, …). They now live in
// `@/components/detail-primitives` so tool-specific renderers can use them
// without importing this module and forming a cycle.
export { CodeBlock, SectionLabel };

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

  const hasResult = result !== undefined && result !== "";
  const isRunning = liveTc
    ? isToolCallRunning(liveTc)
    : detail.status === "running";
  const isError = liveTc?.isError ?? detail.status === "error";
  const hasStreamedOutput = !!streamedOutput;
  const inputJson = JSON.stringify(detail.input, null, 2);

  // Risk assessment can land after the drawer opens — prefer the live call.
  // The raw `riskReason` rule-match string ("ls (default)") is internal
  // classifier jargon and is deliberately NOT shown.
  const riskLevel = liveTc?.riskLevel ?? detail.riskLevel;
  const riskHint = getRiskToleranceHint(riskLevel);
  const riskStyle = getRiskBadgeWeakStyle(riskLevel);

  // Tools with purpose-built activity UI replace the generic name/activity/JSON
  // block; those that also own their output suppress the shared Output section.
  const renderer = getToolActivityRenderer(detail.toolName);

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
          {detail.activity && (
            <Typography
              variant="body-small-default"
              as="p"
              className="mt-0.5 text-[var(--content-secondary)]"
            >
              {detail.activity}
            </Typography>
          )}
          <div className="mt-2">
            <CodeBlock text={inputJson} />
          </div>
        </div>
      )}

      {/* Output — the final result once present, else the live streamed tail
          while running, else a bare running placeholder. Suppressed for tools
          whose renderer already presents the result itself. */}
      {!renderer?.ownsOutput && (hasResult || isRunning) && (
        <div className="mt-5">
          <SectionLabel>{t("toolDetailPanel.output")}</SectionLabel>
          {hasResult ? (
            <CodeBlock text={result as string} />
          ) : hasStreamedOutput ? (
            <CodeBlock text={streamedOutput as string} />
          ) : (
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-tertiary)]"
            >
              {t("toolDetailPanel.running")}
            </Typography>
          )}
        </div>
      )}
    </>
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

  const title = detail.activity || detail.title;

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

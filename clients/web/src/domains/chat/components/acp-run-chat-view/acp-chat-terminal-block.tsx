/**
 * The final system block in the ACP chat transcript. Summarizes how the run
 * ended: a completed run differentiates its `stopReason`; a failed run renders
 * with error styling and surfaces the `error` message.
 *
 * Only terminal statuses produce a block — active statuses render nothing (the
 * trailing agent/thinking block already shows the live indicator).
 */

import { AlertTriangle, CheckCircle2, MinusCircle } from "lucide-react";

import { isActiveAcpStatus, type AcpRunStatus } from "@/utils/acp-run-status";
import { t, useTranslation } from "@/i18n";

export interface AcpChatTerminalBlockProps {
  /** Terminal status of the run. Active statuses render nothing. */
  status: AcpRunStatus;
  /** Raw ACP stop reason; differentiates completed-run copy. */
  stopReason?: string;
  /** Error message shown when the run failed. */
  error?: string;
  /** Epoch-ms the run reached its terminal state; appended as "at {time}". */
  completedAt?: number;
}

/** Completed-run copy keyed off the ACP stop reason. */
function completedLabel(stopReason: string | undefined): string {
  switch (stopReason) {
    case "max_tokens":
    case "max_turn_requests":
      return t("chat:acpChatTerminalBlock.stoppedLimitReached");
    case "refusal":
      return t("chat:acpChatTerminalBlock.refused");
    case "cancelled":
      return t("chat:acpChatTerminalBlock.cancelled");
    case "end_turn":
    default:
      return t("chat:acpChatTerminalBlock.completed");
  }
}

/** Short local clock time, e.g. "3:42 PM". */
function formatTerminalTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** De-emphasized "at {time}" suffix shown beside a terminal label. */
function TerminalTime({ completedAt }: { completedAt: number | undefined }) {
  const { t } = useTranslation("chat");
  if (completedAt === undefined) {
    return null;
  }
  return (
    <span data-testid="acp-chat-terminal-time">
      {t("acpChatTerminalBlock.atTime", {
        time: formatTerminalTime(completedAt),
      })}
    </span>
  );
}

export function AcpChatTerminalBlock({
  status,
  stopReason,
  error,
  completedAt,
}: AcpChatTerminalBlockProps) {
  const { t } = useTranslation("chat");
  if (isActiveAcpStatus(status)) {
    return null;
  }

  if (status === "failed") {
    return (
      <div
        data-testid="acp-chat-terminal-block"
        data-terminal-kind="failed"
        className="flex items-start gap-2 rounded-lg bg-[var(--system-negative-weak)] px-3 py-2 text-body-small-default text-[var(--system-negative-strong)]"
      >
        {/* Row wraps for multi-line errors; the icon box matches the 12px
            text-body-small line-height so the triangle centers on the first
            line rather than the wrapped block's middle. */}
        <span
          aria-hidden
          data-testid="acp-chat-terminal-failed-icon"
          className="flex h-[12px] w-4 shrink-0 items-center justify-center"
        >
          <AlertTriangle className="h-4 w-4" />
        </span>
        <span>{error ?? t("acpChatTerminalBlock.runFailed")}</span>
      </div>
    );
  }

  // `cancelled` status (distinct from a completed-but-cancelled stopReason).
  if (status === "cancelled") {
    return (
      <div
        data-testid="acp-chat-terminal-block"
        data-terminal-kind="cancelled"
        className="flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)]"
      >
        <MinusCircle aria-hidden className="h-4 w-4 shrink-0" />
        <span>{t("acpChatTerminalBlock.cancelled")}</span>
        <TerminalTime completedAt={completedAt} />
      </div>
    );
  }

  const label = completedLabel(stopReason);
  return (
    <div
      data-testid="acp-chat-terminal-block"
      data-terminal-kind="completed"
      className="flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)]"
    >
      <CheckCircle2
        aria-hidden
        className="h-4 w-4 shrink-0 text-[var(--system-positive-strong)]"
      />
      <span>{label}</span>
      <TerminalTime completedAt={completedAt} />
    </div>
  );
}

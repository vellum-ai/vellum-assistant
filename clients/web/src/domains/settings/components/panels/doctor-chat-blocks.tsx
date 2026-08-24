import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  HardDrive,
  Loader2,
  MessageSquareText,
  Shield,
  ThumbsDown,
  ThumbsUp,
  Wrench,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { MarkdownLinkComponent } from "@vellumai/design-library";
import { MarkdownMessage } from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";

import {
  EXTERNAL_LINK_CLASS,
  ExternalAnchor,
} from "@/components/external-anchor";
import type {
  ApprovalMeta,
  BackupPromptMeta,
  ChatEntry,
  ToolCallMeta,
} from "@/domains/settings/components/panels/doctor-history";
import { Trans, useTranslation } from "@/i18n";
import { copyToClipboard } from "@/lib/copy-to-clipboard";

// ---------------------------------------------------------------------------
// MessageCopyButton
// ---------------------------------------------------------------------------

export function MessageCopyButton({ text }: { text: string }) {
  const { t } = useTranslation("settings");
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = () => {
    copyToClipboard(text, {
      errorMessage: t("doctorChatBlocks.copyError"),
      onCopied: () => {
        setCopied(true);
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
        timerRef.current = setTimeout(() => {
          setCopied(false);
          timerRef.current = null;
        }, 1500);
      },
    });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={
        copied
          ? t("doctorChatBlocks.copyTitleCopied")
          : t("doctorChatBlocks.copyTitle")
      }
      aria-label={
        copied
          ? t("doctorChatBlocks.copyAriaCopied")
          : t("doctorChatBlocks.copyAria")
      }
      data-reveal=""
      className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md bg-[var(--surface-overlay)] text-[var(--content-tertiary)] hover:text-[var(--content-secondary)]"
    >
      <div className="relative h-3.5 w-3.5">
        <Check
          className={`absolute inset-0 h-3.5 w-3.5 text-[var(--system-positive-strong)] transition-opacity duration-150 ${
            copied ? "opacity-100" : "opacity-0"
          }`}
        />
        <Copy
          className={`absolute inset-0 h-3.5 w-3.5 transition-opacity duration-150 ${
            copied ? "opacity-0" : "opacity-100"
          }`}
        />
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// ToolCallBlock
// ---------------------------------------------------------------------------

export function ToolCallBlock({
  entry,
}: {
  entry: ChatEntry & { kind: "tool_call"; meta: ToolCallMeta };
}) {
  const { t } = useTranslation("settings");
  const [expanded, setExpanded] = useState(false);
  const { toolName, input, result, isError, status } = entry.meta;
  const isRunning = status === "running";

  const statusLabel = isRunning
    ? t("doctorChatBlocks.runningStep")
    : isError
      ? t("doctorChatBlocks.failedStep")
      : t("doctorChatBlocks.completedStep");

  const canExpand =
    !isRunning && (result !== undefined || Object.keys(input).length > 0);

  return (
    <div className="my-1 w-full">
      <button
        type="button"
        onClick={() => {
          if (canExpand) {
            setExpanded(!expanded);
          }
        }}
        className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 transition-colors ${
          isError
            ? "bg-[var(--system-negative-weak)]"
            : "bg-[var(--surface-base)]"
        } ${canExpand ? "cursor-pointer hover:bg-[var(--surface-hover)]" : "cursor-default"} ${
          expanded ? "rounded-b-none" : ""
        }`}
      >
        {isRunning ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--content-disabled)]" />
        ) : isError ? (
          <XCircle className="h-4 w-4 shrink-0 text-[var(--system-negative-strong)]" />
        ) : (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--system-positive-strong)]" />
        )}
        <span
          className={`text-body-medium-default ${isError ? "text-[var(--system-negative-strong)]" : "text-[var(--content-default)]"}`}
        >
          {statusLabel}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[var(--content-tertiary)]">
          {canExpand &&
            (expanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            ))}
        </span>
      </button>

      {expanded && canExpand && (
        <div
          className={`rounded-b-lg border-t px-3 pb-3 ${
            isError
              ? "border-[var(--system-negative-weak)] bg-[var(--system-negative-weak)]"
              : "border-[var(--border-base)] bg-[var(--surface-base)] dark:bg-[var(--surface-lift)]"
          }`}
        >
          <div className="flex items-center gap-2 py-2">
            <Wrench className="h-3.5 w-3.5" />
            <span className="text-body-medium-lighter text-[var(--content-default)]">
              {toolName}
            </span>
          </div>

          <div className="border-t border-[var(--border-base)]" />

          <div className="mt-2.5">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--content-disabled)]">
              {t("doctorChatBlocks.technicalDetails")}
            </div>
            {Object.entries(input).map(([key, value]) => (
              <div key={key} className="mt-0.5">
                <span className="text-body-medium-default text-[var(--content-default)]">
                  {key}:
                </span>{" "}
                <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
                  {typeof value === "string"
                    ? value.length > 200
                      ? value.slice(0, 200) + "..."
                      : value
                    : JSON.stringify(value)}
                </span>
              </div>
            ))}
          </div>

          {result !== undefined && (
            <div className="mt-3">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--content-disabled)]">
                {t("doctorChatBlocks.output")}
              </div>
              <div
                className={`rounded-md border p-3 ${
                  isError
                    ? "border-[var(--system-negative-weak)] bg-[var(--system-negative-weak)]/50"
                    : "border-[var(--border-element)] bg-[var(--surface-base)]"
                }`}
              >
                <pre
                  className={`max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-body-small-default ${
                    isError
                      ? "text-[var(--system-negative-strong)]"
                      : "text-[var(--content-default)]"
                  }`}
                >
                  {result.length > 2000
                    ? result.slice(0, 2000) + "..."
                    : result}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ApprovalBlock
// ---------------------------------------------------------------------------

export function ApprovalBlock({
  entry,
  onRespond,
  disabled,
}: {
  entry: ChatEntry & { kind: "approval"; meta: ApprovalMeta };
  onRespond: (response: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation("settings");
  const { toolName, description, input } = entry.meta;
  const [showDetails, setShowDetails] = useState(false);

  const hasDetails = !!toolName || !!description || !!input;
  const canApproveFutureExecCommands = toolName === "exec_command";

  return (
    <div className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <Shield className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-disabled)]" />
          <span className="text-body-medium-default text-[var(--content-default)]">
            {t("doctorChatBlocks.confirmationRequired")}
          </span>
        </div>

        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRespond("approve")}
            className="flex items-center gap-1.5 rounded-md bg-[var(--system-positive-strong)] px-3 py-1.5 text-body-small-default text-white transition-colors hover:bg-[var(--system-positive-strong)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("doctorChatBlocks.allowOnce")}
          </button>
          {canApproveFutureExecCommands && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRespond("approve all exec")}
              className="flex items-center gap-1.5 rounded-md border border-[var(--system-positive-strong)] bg-[var(--surface-lift)] px-3 py-1.5 text-body-small-default text-[var(--system-positive-strong)] transition-colors hover:bg-[var(--system-positive-weak)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("doctorChatBlocks.alwaysAllow")}
            </button>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRespond("deny")}
            className="flex items-center gap-1.5 rounded-md border border-[var(--system-negative-strong)] bg-[var(--surface-lift)] px-3 py-1.5 text-body-small-default text-[var(--system-negative-strong)] transition-colors hover:bg-[var(--system-negative-weak)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("doctorChatBlocks.deny")}
          </button>
        </div>
      </div>

      {hasDetails && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowDetails(!showDetails)}
            className="flex items-center gap-1 text-body-small-default text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-default)]"
          >
            <ChevronRight
              className={`h-3 w-3 transition-transform ${showDetails ? "rotate-90" : ""}`}
            />
            {showDetails
              ? t("doctorChatBlocks.hideDetails")
              : t("doctorChatBlocks.showDetails")}
          </button>
          {showDetails && (
            <div className="mt-2 space-y-1.5">
              {toolName && (
                <div className="flex items-center gap-1.5 text-body-small-default text-[var(--content-tertiary)]">
                  <span>{t("doctorChatBlocks.toolLabel")}</span>
                  <code className="rounded bg-[var(--surface-base)] px-1.5 py-0.5 font-mono text-[var(--content-secondary)] dark:bg-[var(--surface-lift)] dark:text-[var(--content-default)]">
                    {toolName}
                  </code>
                </div>
              )}
              {description && (
                <p className="text-body-small-default text-[var(--content-tertiary)]">
                  {description}
                </p>
              )}
              {input && Object.keys(input).length > 0 && (
                <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-[var(--surface-base)] p-2 text-label-medium-default text-[var(--content-secondary)] dark:bg-[var(--surface-lift)] dark:text-[var(--content-default)]">
                  {JSON.stringify(input, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BackupPromptBlock
// ---------------------------------------------------------------------------

export function BackupPromptBlock({
  entry,
  onRespond,
  disabled,
}: {
  entry: ChatEntry & { kind: "backup_prompt"; meta: BackupPromptMeta };
  onRespond: (response: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation("settings");
  const { toolName } = entry.meta;

  return (
    <div className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-disabled)]" />
          <div className="flex flex-col gap-1">
            <span className="text-body-medium-default text-[var(--content-default)]">
              {t("doctorChatBlocks.backupPromptTitle")}
            </span>
            <span className="text-body-small-default text-[var(--content-tertiary)]">
              <Trans
                ns="settings"
                i18nKey="doctorChatBlocks.backupPromptBody"
                values={{ toolName }}
                components={{
                  toolCode: (
                    <code className="rounded bg-[var(--surface-base)] px-1 py-0.5 font-mono text-[var(--content-secondary)]" />
                  ),
                }}
              />
            </span>
          </div>
        </div>

        <div className="flex shrink-0 gap-2">
          <Button
            variant="primary"
            disabled={disabled}
            onClick={() => onRespond("backup")}
          >
            {t("doctorChatBlocks.backUp")}
          </Button>
          <Button
            variant="outlined"
            disabled={disabled}
            onClick={() => onRespond("skip_backup")}
          >
            {t("doctorChatBlocks.skip")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function FeedbackPromptBlock({
  onOpenFeedback,
}: {
  onOpenFeedback: () => void;
}) {
  const { t } = useTranslation("settings");

  return (
    <div className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-disabled)]" />
          <div className="flex flex-col gap-1">
            <span className="text-body-medium-default text-[var(--content-default)]">
              {t("doctorChatBlocks.feedbackTitle")}
            </span>
            <span className="text-body-small-default text-[var(--content-tertiary)]">
              {t("doctorChatBlocks.feedbackBody")}
            </span>
          </div>
        </div>

        <div className="flex shrink-0">
          <Button
            variant="outlined"
            onClick={onOpenFeedback}
            leftIcon={<MessageSquareText />}
          >
            {t("doctorChatBlocks.shareFeedback")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function UserOutcomePromptBlock({
  question,
  answer,
  onRespond,
  disabled,
}: {
  question: string;
  answer?: "resolved" | "not_resolved";
  onRespond: (resolved: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("settings");

  return (
    <div className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-disabled)]" />
          <span className="text-body-medium-default text-[var(--content-default)]">
            {question}
          </span>
        </div>

        {answer ? (
          <span className="flex shrink-0 items-center gap-1.5 text-body-small-default text-[var(--content-tertiary)]">
            {answer === "resolved" ? (
              <>
                <ThumbsUp className="h-4 w-4 text-[var(--system-positive-strong)]" />
                {t("doctorChatBlocks.gladSolved")}
              </>
            ) : (
              <>
                <ThumbsDown className="h-4 w-4" />
                {t("doctorChatBlocks.notSolved")}
              </>
            )}
          </span>
        ) : (
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outlined"
              onClick={() => onRespond(true)}
              disabled={disabled}
              iconOnly={<ThumbsUp />}
              aria-label={t("doctorChatBlocks.solvedAria")}
              title={t("doctorChatBlocks.solvedAria")}
            />
            <Button
              variant="outlined"
              onClick={() => onRespond(false)}
              disabled={disabled}
              iconOnly={<ThumbsDown />}
              aria-label={t("doctorChatBlocks.notSolvedAria")}
              title={t("doctorChatBlocks.notSolvedAria")}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message rendering helpers
// ---------------------------------------------------------------------------

export function UserMessage({ entry }: { entry: ChatEntry }) {
  return (
    <div data-reveal-row="" className="flex items-start justify-end gap-1.5">
      <div className="flex shrink-0 items-center self-center">
        <MessageCopyButton text={entry.content} />
      </div>
      <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-[var(--surface-lift)] px-4 py-3 text-chat text-[var(--content-default)]">
        {entry.content}
      </div>
    </div>
  );
}

/**
 * The design-library default anchor is web-only, so doctor's links have to
 * carry the app's external-link behaviour themselves to stay alive in the
 * native shells.
 */
const DoctorLink: MarkdownLinkComponent = ({ href, children }) => (
  <ExternalAnchor href={href} className={EXTERNAL_LINK_CLASS}>
    {children}
  </ExternalAnchor>
);

export function AssistantMessage({ entry }: { entry: ChatEntry }) {
  return (
    <div data-reveal-row="" className="flex items-start justify-start gap-1.5">
      <div className="w-full text-chat text-[var(--content-default)]">
        <MarkdownMessage content={entry.content} linkComponent={DoctorLink} />
      </div>
      <div className="flex shrink-0 items-center pt-0.5">
        <MessageCopyButton text={entry.content} />
      </div>
    </div>
  );
}

export function ErrorMessage({ entry }: { entry: ChatEntry }) {
  return (
    <div className="flex items-start gap-2 text-body-small-default text-[var(--system-negative-strong)]">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{entry.content}</span>
    </div>
  );
}

export function StatusMessage({ entry }: { entry: ChatEntry }) {
  return (
    <div className="text-center text-body-small-default text-[var(--content-disabled)]">
      {entry.content}
    </div>
  );
}

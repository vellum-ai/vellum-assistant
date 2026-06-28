import { BusyIndicator } from "@/domains/chat/components/busy-indicator";
import {
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clipboard,
  Compass,
  FileText,
  FilePlus,
  Globe,
  Loader2,
  Pencil,
  Search,
  Terminal,
  Wrench,
  XCircle,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";

import {
  getRiskBadgeStyle,
  getProvenanceText,
  wasExpected,
  getEffectiveRiskDisplay,
} from "@/domains/chat/utils/risk";
import {
  formatStartTime,
  useElapsedTime,
} from "@/domains/chat/hooks/use-elapsed-time";

import type { ConfirmationDecision } from "@/types/event-types";
import type {
  AllowlistOption,
  DirectoryScopeOption,
  ScopeOption,
} from "@/types/interaction-ui-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { perceivedStartedAt } from "@/domains/chat/utils/tool-call-status";
import {
  extractInputSummary,
  friendlyRunningLabel,
  friendlyToolIcon,
  friendlyToolLabel,
} from "@/domains/chat/components/tool-call-chip/utils";

export interface ToolCallChipProps {
  toolCall: ChatMessageToolCall;
  onOpenRuleEditor?: (context: {
    toolName: string;
    riskLevel?: string;
    riskReason?: string;
    input: Record<string, unknown>;
    allowlistOptions: AllowlistOption[];
    scopeOptions: ScopeOption[];
    directoryScopeOptions: DirectoryScopeOption[];
    matchedTrustRuleId?: string;
  }) => void;
  onConfirmationSubmit?: (
    decision: ConfirmationDecision,
    toolCall: ChatMessageToolCall,
  ) => void | Promise<void>;
  onAllowAndCreateRule?: (
    toolCall: ChatMessageToolCall,
  ) => void | Promise<void>;
  /** When true, skip the outer header row ("Running 1 step") and render
   *  the sub-item row + details directly. Used inside MultiActivityGroup
   *  to avoid double-nesting. */
  embedded?: boolean;
}

const ICON_MAP: Record<string, ReactNode> = {
  terminal: <Terminal className="h-3.5 w-3.5" />,
  "file-text": <FileText className="h-3.5 w-3.5" />,
  "file-plus": <FilePlus className="h-3.5 w-3.5" />,
  pencil: <Pencil className="h-3.5 w-3.5" />,
  search: <Search className="h-3.5 w-3.5" />,
  globe: <Globe className="h-3.5 w-3.5" />,
  compass: <Compass className="h-3.5 w-3.5" />,
  camera: <Camera className="h-3.5 w-3.5" />,
  wrench: <Wrench className="h-3.5 w-3.5" />,
};

function getIcon(toolName: string, inputSummary: string = ""): ReactNode {
  const iconKey = friendlyToolIcon(toolName, inputSummary);
  return ICON_MAP[iconKey] ?? <Wrench className="h-3.5 w-3.5" />;
}

function StatusIcon({
  isRunning,
  isError,
}: {
  isRunning: boolean;
  isError: boolean;
}) {
  if (isRunning) {
    // Wrap in a fixed-size slot so the layout doesn't shift when the icon
    // transitions from the 16px circle icons to the 6px pulsing dot.
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <BusyIndicator size={6} />
      </span>
    );
  }
  if (isError) {
    return (
      <XCircle className="h-4 w-4 text-[var(--system-negative-strong)] shrink-0" />
    );
  }
  return (
    <CheckCircle2 className="h-4 w-4 text-[var(--system-positive-strong)] shrink-0" />
  );
}

/**
 * Inline confirmation card rendered inside the expanded tool call panel
 * when `toolCall.pendingConfirmation` is set. Matches the macOS
 * `PermissionPromptView` layout.
 */
function InlineConfirmationCard({
  toolCall,
  isSubmitting,
  onSubmit,
  onAllowAndCreateRule,
}: {
  toolCall: ChatMessageToolCall;
  isSubmitting: boolean;
  onSubmit?: (decision: ConfirmationDecision) => void;
  onAllowAndCreateRule?: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [showSplitMenu, setShowSplitMenu] = useState(false);
  const splitMenuRef = useRef<HTMLDivElement>(null);

  // Close split menu when clicking outside
  useEffect(() => {
    if (!showSplitMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        splitMenuRef.current &&
        !splitMenuRef.current.contains(e.target as Node)
      ) {
        setShowSplitMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showSplitMenu]);

  const confirmation = toolCall.pendingConfirmation;
  if (!confirmation) return null;

  const riskBadge = confirmation.riskLevel
    ? getRiskBadgeStyle(confirmation.riskLevel)
    : null;
  const hasDetails = !!confirmation.input;
  const hasAllowlistOptions = (confirmation.allowlistOptions?.length ?? 0) > 0;

  return (
    <div className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] p-3">
      {/* Row 1: title + risk badge */}
      <div className="flex items-center gap-2">
        {/* typography: off-scale — semibold to match macOS bodyMediumEmphasised */}
        <span className="text-body-medium-default font-semibold text-[var(--content-default)]">
          {confirmation.title ?? "Confirmation required"}
        </span>
        {riskBadge && (
          <span
            // typography: off-scale — compact risk badge pill

            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium leading-tight ${riskBadge.bg} ${riskBadge.text}`}
          >
            {riskBadge.label}
          </span>
        )}
      </div>

      {/* Row 2: risk reason */}
      {confirmation.riskReason && (
        <p className="mt-1 text-label-medium-default text-[var(--content-tertiary)]">
          {confirmation.riskReason}
        </p>
      )}

      {/* Row 3: action buttons (right-aligned) */}
      <div className="mt-3 flex justify-end gap-2">
        {/* Allow button — split when allowlistOptions present */}
        {hasAllowlistOptions && onAllowAndCreateRule ? (
          <div ref={splitMenuRef} className="relative flex">
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => onSubmit?.("allow")}
              className="flex items-center gap-1.5 rounded-l-md bg-[var(--primary-base)] px-3 py-1.5 text-body-small-default text-[var(--content-inset)] transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Allow
            </button>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => setShowSplitMenu((v) => !v)}
              className="flex items-center rounded-r-md border-l border-[var(--content-inset)]/30 bg-[var(--primary-base)] px-1.5 py-1.5 text-[var(--content-inset)] transition-colors hover:opacity-90 disabled:opacity-50"
              aria-label="More allow options"
              aria-haspopup="menu"
              aria-expanded={showSplitMenu}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {showSplitMenu && (
              <div className="absolute right-0 top-full z-10 mt-1 min-w-[180px] rounded-md border border-[var(--border-base)] bg-[var(--surface-lift)] py-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => {
                    setShowSplitMenu(false);
                    onAllowAndCreateRule();
                  }}
                  className="flex w-full items-center px-3 py-2 text-body-small-default text-[var(--content-default)] transition-colors hover:bg-[var(--ghost-hover)]"
                >
                  Allow &amp; Create Rule
                </button>
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => onSubmit?.("allow")}
            className="flex items-center gap-1.5 rounded-md bg-[var(--primary-base)] px-3 py-1.5 text-body-small-default text-[var(--content-inset)] transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {isSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Allow
          </button>
        )}

        <button
          type="button"
          disabled={isSubmitting}
          onClick={() => onSubmit?.("deny")}
          className="flex items-center gap-1.5 rounded-md bg-[var(--system-negative-strong)] px-3 py-1.5 text-body-small-default text-white transition-colors hover:opacity-90 disabled:opacity-50"
        >
          Deny
        </button>
      </div>

      {/* Row 4: Show/Hide details toggle */}
      {hasDetails && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowDetails(!showDetails)}
            className="flex items-center gap-1 text-label-medium-default text-[var(--content-default)]"
          >
            <ChevronRight
              className={`h-3 w-3 transition-transform ${showDetails ? "rotate-90" : ""}`}
            />
            {showDetails ? "Hide details" : "Show details"}
          </button>

          {/* Row 5: details content — single formatted input block matching macOS codePreviewBlock */}
          {showDetails && confirmation.input && (
            <div className="mt-2 max-h-[220px] overflow-y-auto rounded bg-[var(--surface-overlay)] p-2">
              <pre className="whitespace-pre-wrap break-words font-mono text-body-small-default text-[var(--content-secondary)]">
                {JSON.stringify(confirmation.input, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolCallChip({
  toolCall,
  onOpenRuleEditor,
  onConfirmationSubmit,
  onAllowAndCreateRule,
  embedded = false,
}: ToolCallChipProps) {
  const expanded = useChatSessionStore((s) =>
    s.expandedToolCallIds.has(toolCall.id),
  );
  const toggleExpanded = useCallback(
    (next: boolean) => {
      useChatSessionStore.getState().setExpandedToolCallId(toolCall.id, next);
    },
    [toolCall.id],
  );
  // Per-chip submission state. Each tool call that is awaiting a confirmation
  // renders its own inline card and tracks its own in-flight Allow/Deny, so a
  // second confirmation outstanding in the same turn stays independently
  // actionable (tools run via Promise.all — two prompts can overlap).
  const [isSubmittingConfirmation, setIsSubmittingConfirmation] =
    useState(false);
  // `status` is not stored; the chip only needs the two booleans it branches
  // on. An errored call resolves to error; otherwise a call is still running
  // until it has either a result payload or a (force-)completion timestamp.
  const isError = Boolean(toolCall.isError);
  const isRunning =
    !isError && toolCall.result === undefined && toolCall.completedAt == null;
  const hasPendingConfirmation = !!toolCall.pendingConfirmation;
  // Headline duration is the user-perceived "time they feel": it anchors on the
  // first-byte `previewStartedAt` (falling back to execution start) so the
  // counter captures the input-streaming gap before the tool actually runs.
  const perceivedStart = perceivedStartedAt(toolCall);
  const duration = useElapsedTime(
    perceivedStart,
    !isRunning,
    toolCall.completedAt,
  );
  const startTimeLabel = formatStartTime(perceivedStart);
  // The tool's own execution latency (`startedAt` → `completedAt`), surfaced as
  // a separate field on expand. Distinct from the perceived `duration` above.
  const executionDuration = useElapsedTime(
    toolCall.startedAt,
    !isRunning,
    toolCall.completedAt,
  );

  const inputSummary = extractInputSummary(toolCall.name, toolCall.input);
  const activity = toolCall.input?.activity ?? toolCall.input?.reason;
  const activityLabel =
    typeof activity === "string" && activity.trim() ? activity.trim() : null;
  const label =
    activityLabel ??
    (isRunning
      ? friendlyRunningLabel(toolCall.name, inputSummary)
      : friendlyToolLabel(toolCall.name, inputSummary));

  const canExpand =
    hasPendingConfirmation ||
    (!isRunning &&
      (toolCall.result !== undefined ||
        Object.keys(toolCall.input).length > 0));

  // Auto-expand on the false→true transition of pendingConfirmation so the
  // inline approve/deny card is immediately visible. Initialized to `false`
  // so a chip that mounts with a pending confirmation expands immediately.
  // Tracks the previous value to fire only on the transition — this lets the
  // user manually collapse without the effect re-expanding it every render.
  const prevPendingRef = useRef(false);
  useEffect(() => {
    const wasPending = prevPendingRef.current;
    prevPendingRef.current = !!toolCall.pendingConfirmation;
    if (toolCall.pendingConfirmation && !wasPending) {
      toggleExpanded(true);
    }
  }, [toolCall.pendingConfirmation, toggleExpanded]);

  const handleConfirmationSubmit = useCallback(
    async (decision: ConfirmationDecision) => {
      if (!onConfirmationSubmit) return;
      setIsSubmittingConfirmation(true);
      try {
        await onConfirmationSubmit(decision, toolCall);
      } finally {
        setIsSubmittingConfirmation(false);
      }
    },
    [onConfirmationSubmit, toolCall],
  );

  const handleAllowAndCreateRule = useCallback(async () => {
    if (!onAllowAndCreateRule) return;
    setIsSubmittingConfirmation(true);
    try {
      await onAllowAndCreateRule(toolCall);
    } finally {
      setIsSubmittingConfirmation(false);
    }
  }, [onAllowAndCreateRule, toolCall]);

  const handleCopyOutput = useCallback(() => {
    if (toolCall.result !== undefined) {
      void navigator.clipboard.writeText(toolCall.result);
    }
  }, [toolCall.result]);

  const statusLabel = isRunning
    ? "Running 1 step"
    : isError
      ? "Failed 1 step"
      : "Completed 1 step";

  const subItemRow = (
    <div
      className={`flex min-w-0 items-center gap-2 py-2 ${embedded ? "pl-6 pr-3 text-body-small-default" : ""}`}
    >
      <StatusIcon isRunning={isRunning} isError={isError} />
      {!embedded && getIcon(toolCall.name, inputSummary)}
      <span className="min-w-0 truncate text-[var(--content-secondary)]">
        {label}
      </span>
      {toolCall.riskLevel &&
        !isRunning &&
        !hasPendingConfirmation &&
        (() => {
          const { displayLevel, inherentRisk } = getEffectiveRiskDisplay(
            toolCall.approvalReason,
            toolCall.riskLevel,
          );
          const badge = getRiskBadgeStyle(displayLevel);
          const isWorkspace = displayLevel === "workspace";

          // For workspace chips, skip provenance — the chip itself is the provenance indicator.
          // For normal badges, check wasExpected against the original riskLevel.
          const unexpected =
            !isWorkspace &&
            !wasExpected(
              toolCall.approvalMode,
              toolCall.riskLevel,
              toolCall.riskThreshold,
            );
          const provenance = unexpected
            ? getProvenanceText(toolCall.approvalReason)
            : null;

          let displayLabel: string;
          if (isWorkspace) {
            const capitalizedRisk = inherentRisk
              ? inherentRisk.charAt(0).toUpperCase() + inherentRisk.slice(1)
              : "Unknown";
            displayLabel = `Workspace · Inherent risk: ${capitalizedRisk}`;
          } else {
            displayLabel = provenance
              ? `${badge.label} ${provenance}`
              : badge.label;
          }

          return (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenRuleEditor?.({
                  toolName: toolCall.name,
                  riskLevel: toolCall.riskLevel,
                  riskReason: toolCall.riskReason,
                  input: toolCall.input,
                  allowlistOptions: toolCall.riskAllowlistOptions ?? [],
                  scopeOptions: toolCall.scopeOptions ?? [],
                  directoryScopeOptions:
                    toolCall.riskDirectoryScopeOptions ?? [],
                  matchedTrustRuleId: toolCall.matchedTrustRuleId,
                });
              }}
              // typography: off-scale — compact risk badge pill

              className={`${embedded ? "" : "ml-auto "}max-w-[45%] shrink-0 truncate rounded-full px-2 py-0.5 text-[11px] font-medium leading-tight ${badge.bg} ${badge.text} ${badge.border ?? ""} ${onOpenRuleEditor ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
              title={displayLabel}
            >
              <span className="sm:hidden">{badge.label}</span>
              <span className="hidden sm:inline">
                {isWorkspace ? badge.label : displayLabel}
              </span>
            </button>
          );
        })()}
      {embedded && (
        <span className="ml-auto flex items-center gap-1.5 text-[var(--content-tertiary)]">
          {duration && (
            <span className="text-label-small-default" title={startTimeLabel}>
              {duration}
            </span>
          )}
          {canExpand &&
            (expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            ))}
        </span>
      )}
    </div>
  );

  const detailsPanel = (
    <>
      {/* Inline confirmation card — rendered per-chip directly from
          tc.pendingConfirmation so overlapping confirmations are each visible. */}
      {hasPendingConfirmation && (
        <InlineConfirmationCard
          toolCall={toolCall}
          isSubmitting={isSubmittingConfirmation}
          onSubmit={handleConfirmationSubmit}
          onAllowAndCreateRule={handleAllowAndCreateRule}
        />
      )}

      {/* TECHNICAL DETAILS + OUTPUT only shown when no pending confirmation */}
      {!hasPendingConfirmation && (
        <>
          {/* TECHNICAL DETAILS section */}
          <div className="mt-2.5">
            <div className="mb-1.5 text-label-small-default uppercase tracking-wider text-[var(--content-tertiary)]">
              Technical Details
            </div>
            <div className="text-[var(--content-secondary)]">Tool Name</div>
            <div className="text-[var(--content-secondary)]">
              {toolCall.name
                .replace(/_/g, " ")
                .replace(/\b\w/g, (c) => c.toUpperCase())}
            </div>
            {startTimeLabel && (
              <div className="mt-0.5 text-[var(--content-tertiary)]">
                {startTimeLabel}
              </div>
            )}
            {executionDuration && (
              <div className="mt-0.5">
                <span className="text-label-medium-default text-[var(--content-default)]">
                  Tool latency:
                </span>{" "}
                <span className="text-[var(--content-tertiary)]">
                  {executionDuration}
                </span>
              </div>
            )}
            {Object.entries(toolCall.input).map(([key, value]) => (
              <div key={key} className="mt-0.5">
                <span className="text-label-medium-default text-[var(--content-default)]">
                  {key}:
                </span>{" "}
                <span className="text-[var(--content-tertiary)]">
                  {typeof value === "string"
                    ? value.length > 200
                      ? value.slice(0, 200) + "..."
                      : value
                    : JSON.stringify(value)}
                </span>
              </div>
            ))}
          </div>

          {/* OUTPUT section */}
          {toolCall.result !== undefined && (
            <div className="mt-3">
              <div className="mb-1.5 text-label-small-default uppercase tracking-wider text-[var(--content-tertiary)]">
                Output
              </div>
              <div
                className={`relative rounded-md border p-3 ${
                  isError
                    ? "border-[var(--system-negative-weak)] bg-[var(--system-negative-weak)]"
                    : "border-[var(--border-element)] bg-[var(--surface-base)]"
                }`}
              >
                <pre
                  className={`whitespace-pre-wrap break-words text-body-small-default max-h-60 overflow-y-auto pr-8 ${
                    isError
                      ? "text-[var(--system-negative-strong)]"
                      : "text-[var(--content-default)]"
                  }`}
                >
                  {toolCall.result.length > 2000
                    ? toolCall.result.slice(0, 2000) + "..."
                    : toolCall.result}
                </pre>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCopyOutput();
                  }}
                  className="absolute right-2 top-2 rounded p-1 text-[var(--content-tertiary)] hover:bg-[var(--ghost-hover)] hover:text-[var(--content-default)]"
                  title="Copy output"
                >
                  <Clipboard className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );

  if (embedded) {
    return (
      <div className="w-full">
        <div
          role="button"
          tabIndex={canExpand ? 0 : undefined}
          onClick={() => {
            if (canExpand) toggleExpanded(!expanded);
          }}
          onKeyDown={(e) => {
            if (canExpand && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              toggleExpanded(!expanded);
            }
          }}
          className={`w-full ${canExpand ? "cursor-pointer" : "cursor-default"}`}
        >
          {subItemRow}
        </div>
        {expanded &&
          canExpand &&
          (hasPendingConfirmation ? (
            // Confirmation card gets full-width (px-3) to match macOS PermissionPromptView
            <div className="px-3 pt-1 pb-2">
              <InlineConfirmationCard
                toolCall={toolCall}
                isSubmitting={isSubmittingConfirmation}
                onSubmit={handleConfirmationSubmit}
                onAllowAndCreateRule={handleAllowAndCreateRule}
              />
            </div>
          ) : (
            // Technical details stay indented under the tool label
            <div className="pl-6 pr-3 pb-2 text-label-medium-default">
              {detailsPanel}
            </div>
          ))}
      </div>
    );
  }

  return (
    <div className="my-1 w-full">
      {/* Header row */}
      <button
        type="button"
        onClick={() => {
          if (canExpand) toggleExpanded(!expanded);
        }}
        className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-body-medium-default transition-colors ${
          isError
            ? "bg-[var(--system-negative-weak)]"
            : "bg-[var(--surface-base)]"
        } ${canExpand ? "cursor-pointer hover:bg-[var(--surface-active)]" : "cursor-default"} ${
          expanded ? "rounded-b-none" : ""
        }`}
      >
        <StatusIcon isRunning={isRunning} isError={isError} />
        <span
          className={
            isError
              ? "text-[var(--system-negative-strong)]"
              : "text-[var(--content-default)]"
          }
        >
          {statusLabel}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[var(--content-tertiary)]">
          {duration && (
            <span
              className="text-label-small-default text-[var(--content-tertiary)]"
              title={startTimeLabel}
            >
              {duration}
            </span>
          )}
          {canExpand &&
            (expanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            ))}
        </span>
      </button>

      {/* Expanded details panel */}
      {expanded && canExpand && (
        <div
          className={`rounded-b-lg border-t px-3 pb-3 text-label-medium-default ${
            isError
              ? "border-[var(--system-negative-weak)] bg-[var(--system-negative-weak)]"
              : "border-[var(--border-element)] bg-[var(--surface-base)]"
          }`}
        >
          {subItemRow}
          {detailsPanel}
        </div>
      )}
    </div>
  );
}

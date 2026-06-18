
import {
    ArrowDownToLine,
    ArrowUpFromLine,
    Ban,
    CircleCheck,
    Loader2,
    TriangleAlert,
    Users,
    Workflow,
    X,
} from "lucide-react";

import { useEffect, useState } from "react";

import {
    AnimatedMetricCard,
    formatNumber,
} from "@/domains/chat/components/metric-card";
import { WorkflowStatusBadge } from "@/domains/chat/components/workflow-status-badge";
import type { WorkflowEntry, WorkflowLeaf } from "@/domains/chat/workflow-store";
import { isActiveStatus } from "@/utils/workflow-status";
import { Button, Typography } from "@vellumai/design-library";

// ---------------------------------------------------------------------------
// Leaf tree
// ---------------------------------------------------------------------------

function LeafStatusIcon({ status }: { status: WorkflowLeaf["status"] }) {
  const baseClass = "h-3.5 w-3.5 shrink-0";
  switch (status) {
    case "completed":
      return (
        <CircleCheck
          className={baseClass}
          style={{ color: "var(--system-positive-strong)" }}
        />
      );
    case "failed":
      return (
        <TriangleAlert
          className={baseClass}
          style={{ color: "var(--system-negative-strong)" }}
        />
      );
    case "cancelled":
      return (
        <Ban
          className={baseClass}
          style={{ color: "var(--content-secondary)" }}
          role="img"
          aria-label="Cancelled"
        />
      );
    default:
      return (
        <Loader2
          className={`${baseClass} animate-spin`}
          style={{ color: "var(--primary-base)" }}
        />
      );
  }
}

function LeafRow({ leaf }: { leaf: WorkflowLeaf }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = Boolean(leaf.resultSummary);
  const title = leaf.label ?? `Leaf ${leaf.seq}`;

  return (
    <div className="rounded-lg bg-[var(--surface-overlay)] px-4 py-3">
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 text-left disabled:cursor-default"
      >
        <LeafStatusIcon status={leaf.status} />
        <Typography
          variant="body-medium-default"
          className="min-w-0 flex-1 truncate text-[var(--content-default)]"
        >
          {title}
        </Typography>
        {hasDetail && (
          <Typography
            variant="body-small-default"
            className="shrink-0 text-[var(--content-tertiary)]"
          >
            {expanded ? "Hide" : "Details"}
          </Typography>
        )}
      </button>

      {leaf.promptSummary && (
        <Typography
          variant="body-medium-lighter"
          as="p"
          className="mt-1 whitespace-pre-wrap break-words text-[var(--content-secondary)]"
        >
          {leaf.promptSummary}
        </Typography>
      )}

      {hasDetail && expanded && (
        <Typography
          variant="body-medium-lighter"
          as="p"
          className="mt-2 whitespace-pre-wrap break-words text-[var(--content-secondary)]"
        >
          {leaf.resultSummary}
        </Typography>
      )}
    </div>
  );
}

function LeafTree({ leaves }: { leaves: Map<number, WorkflowLeaf> }) {
  const sorted = [...leaves.values()].sort((a, b) => a.seq - b.seq);

  if (sorted.length === 0) {
    return (
      <Typography
        variant="body-small-default"
        className="py-4 text-center text-[var(--content-tertiary)]"
      >
        No agents yet
      </Typography>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {sorted.map((leaf) => (
        <LeafRow key={leaf.seq} leaf={leaf} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WorkflowDetailPanelProps {
  entry: WorkflowEntry;
  onClose: () => void;
  onStop?: (runId: string) => void;
  onRequestJournal?: (runId: string) => void;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function WorkflowDetailPanel({
  entry,
  onClose,
  onStop,
  onRequestJournal,
}: WorkflowDetailPanelProps) {
  const isRunning = isActiveStatus(entry.status);
  const title = entry.label ?? entry.runId;
  const agentCount = entry.agentsSpawned || entry.leaves.size;

  // Reconcile leaves against the journal once on open (while live) and
  // again when the run reaches a terminal state — a `final` fetch flips
  // any leaf left stuck "running" by a dropped SSE event. The store
  // dedups per `(runId, phase)`, so the repeat on re-render is cheap.
  const journalPhase = isRunning ? "live" : "final";
  useEffect(() => {
    onRequestJournal?.(entry.runId);
  }, [entry.runId, journalPhase, onRequestJournal]);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl bg-[var(--surface-lift)]">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-base)] px-5 py-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-overlay)]">
          <Workflow className="h-4 w-4" style={{ color: "var(--content-secondary)" }} />
        </div>
        <Typography
          variant="title-medium"
          title={title}
          className="min-w-0 shrink truncate text-[var(--content-default)]"
        >
          {title}
        </Typography>
        <WorkflowStatusBadge status={entry.status} />
        <span className="flex-1" />
        {isRunning && onStop && (
          <button
            type="button"
            aria-label="Stop workflow"
            onClick={() => onStop(entry.runId)}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--system-negative-strong)] px-3 py-1.5 text-white transition-colors hover:bg-[color-mix(in_srgb,var(--system-negative-strong)_85%,black)]"
          >
            <Typography variant="label-small-default" className="text-white">
              Stop
            </Typography>
          </button>
        )}
        <Button
          variant="ghost"
          iconOnly={<X />}
          onClick={onClose}
          aria-label="Close workflow detail"
          tooltip="Close"
          className="shrink-0"
        />
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {/* Metrics row */}
        <div className="mb-5 grid grid-cols-3 gap-3">
          <AnimatedMetricCard
            icon={<ArrowDownToLine className="h-4 w-4 shrink-0" style={{ color: "var(--content-secondary)" }} />}
            target={entry.inputTokens}
            format={(n) => formatNumber(Math.round(n))}
            label="Input"
          />
          <AnimatedMetricCard
            icon={<ArrowUpFromLine className="h-4 w-4 shrink-0" style={{ color: "var(--content-secondary)" }} />}
            target={entry.outputTokens}
            format={(n) => formatNumber(Math.round(n))}
            label="Output"
          />
          <AnimatedMetricCard
            icon={<Users className="h-4 w-4 shrink-0" style={{ color: "var(--content-secondary)" }} />}
            target={agentCount}
            format={(n) => formatNumber(Math.round(n))}
            label="Agents"
          />
        </div>

        {/* Phase banner */}
        {entry.phase && (
          <div className="mb-5 rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] px-4 py-3">
            <Typography
              variant="body-medium-default"
              className="text-[var(--content-default)]"
            >
              {entry.phase}
            </Typography>
          </div>
        )}

        {/* Summary section */}
        {entry.summary && (
          <div className="mb-5 rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] px-4 py-3">
            <Typography
              variant="body-medium-default"
              as="h3"
              className="mb-2 text-[var(--content-emphasised)]"
            >
              Summary
            </Typography>
            <Typography
              variant="body-medium-lighter"
              as="p"
              className="whitespace-pre-wrap break-words leading-relaxed text-[var(--content-default)]"
            >
              {entry.summary}
            </Typography>
          </div>
        )}

        {/* Leaf tree section */}
        <div>
          <Typography
            variant="title-medium"
            as="h3"
            className="mb-4 text-[var(--content-emphasised)]"
          >
            Agents
          </Typography>
          <LeafTree leaves={entry.leaves} />
        </div>
      </div>
    </div>
  );
}

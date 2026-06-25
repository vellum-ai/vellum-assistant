
import {
    ArrowDownToLine,
    ArrowUpFromLine,
    Users,
    Workflow,
    X,
} from "lucide-react";

import { useEffect } from "react";

import {
    AnimatedMetricCard,
    formatNumber,
} from "@/domains/chat/components/metric-card";
import { StopButton } from "@/domains/chat/components/stop-button";
import { WorkflowStatusBadge } from "@/domains/chat/components/workflow-status-badge";
import { WorkflowSubagentRow } from "@/domains/chat/components/workflow-subagent-row";
import type { WorkflowEntry } from "@/domains/chat/workflow-store";
import { isActiveStatus } from "@/utils/workflow-status";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";
import { Button, Typography } from "@vellumai/design-library";

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
  const components = useBundledAvatarComponents();
  const sortedLeaves = [...entry.leaves.values()].sort((a, b) => a.seq - b.seq);

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
      {/* Header. No breadcrumb at the top level — like the subagent timeline,
          the breadcrumb only appears once a deeper view is drilled into, which
          the workflow panel never does. */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-hover)] px-5 py-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] bg-[var(--surface-overlay)]">
          <Workflow
            className="h-4 w-4"
            style={{ color: "var(--content-secondary)" }}
          />
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
          <StopButton
            onClick={() => onStop(entry.runId)}
            ariaLabel="Stop workflow"
          />
        )}
        <Button
          variant="outlined"
          iconOnly={<X />}
          onClick={onClose}
          aria-label="Close workflow detail"
          tooltip="Close"
          className="shrink-0 rounded-lg"
        />
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {/* Metrics row */}
        <div className="mb-5 grid grid-cols-3 gap-3">
          <AnimatedMetricCard
            icon={
              <ArrowDownToLine
                className="h-4 w-4 shrink-0"
                style={{ color: "var(--content-secondary)" }}
              />
            }
            target={entry.inputTokens}
            format={(n) => formatNumber(Math.round(n))}
            label="Input"
          />
          <AnimatedMetricCard
            icon={
              <ArrowUpFromLine
                className="h-4 w-4 shrink-0"
                style={{ color: "var(--content-secondary)" }}
              />
            }
            target={entry.outputTokens}
            format={(n) => formatNumber(Math.round(n))}
            label="Output"
          />
          <AnimatedMetricCard
            icon={
              <Users
                className="h-4 w-4 shrink-0"
                style={{ color: "var(--content-secondary)" }}
              />
            }
            target={agentCount}
            format={(n) => formatNumber(Math.round(n))}
            label="Agents"
          />
        </div>

        {/* Subagents section */}
        <div>
          <Typography
            variant="body-medium-default"
            as="h3"
            className="mb-4 text-[var(--content-emphasised)]"
          >
            Subagents
          </Typography>
          {sortedLeaves.length === 0 ? (
            <Typography
              variant="body-small-default"
              className="py-4 text-center text-[var(--content-tertiary)]"
            >
              No subagents yet
            </Typography>
          ) : (
            <div className="flex flex-col gap-1">
              {sortedLeaves.map((leaf) => (
                <WorkflowSubagentRow
                  key={leaf.seq}
                  runId={entry.runId}
                  leaf={leaf}
                  components={components}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


import {
    ArrowDownToLine,
    ArrowLeft,
    ArrowUpFromLine,
    ChevronRight,
    Users,
    Workflow,
    X,
} from "lucide-react";

import { useCallback, useEffect, useState } from "react";

import { motion, useReducedMotion } from "motion/react";

import { AvatarRenderer } from "@/components/avatar-renderer";
import {
    AnimatedMetricCard,
    formatNumber,
} from "@/domains/chat/components/metric-card";
import { StopButton } from "@/domains/chat/components/stop-button";
import { WorkflowLeafDetail } from "@/domains/chat/components/workflow-leaf-detail";
import {
    WorkflowLeafStatusBadge,
    WorkflowStatusBadge,
} from "@/domains/chat/components/workflow-status-badge";
import { WorkflowSubagentRow } from "@/domains/chat/components/workflow-subagent-row";
import type { WorkflowEntry } from "@/domains/chat/workflow-store";
import { subagentTraits } from "@/utils/avatar-subagent";
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
  const reduce = useReducedMotion();
  const title = entry.label ?? entry.runId;
  const agentCount = entry.agentsSpawned || entry.leaves.size;
  const components = useBundledAvatarComponents();
  const sortedLeaves = [...entry.leaves.values()].sort((a, b) => a.seq - b.seq);

  // Which leaf's nested detail is open (its `seq`), or `null` for the list view.
  const [selectedLeafSeq, setSelectedLeafSeq] = useState<number | null>(null);

  // Reset to the list when the run changes — the panel instance is reused
  // across runs (no `key`), so a detail opened for one run must not leak onto
  // the next.
  const [prevRunId, setPrevRunId] = useState(entry.runId);
  if (prevRunId !== entry.runId) {
    setPrevRunId(entry.runId);
    setSelectedLeafSeq(null);
  }

  // The selected leaf, or `undefined` when nothing is selected or the seq no
  // longer exists (defensive — every view below gates on this, so a vanished
  // leaf falls back to the list).
  const selectedLeaf =
    selectedLeafSeq != null ? entry.leaves.get(selectedLeafSeq) : undefined;
  const selectedTraits = selectedLeaf
    ? subagentTraits(`${entry.runId}:${selectedLeaf.seq}`)
    : undefined;

  // Returns from a leaf's nested detail to the subagents list. Shared by the
  // header Back button and the breadcrumb's workflow crumb.
  const handleBack = useCallback(() => setSelectedLeafSeq(null), []);

  // The header/breadcrumb title tracks the deepest crumb: the workflow at the
  // list, the drilled-into leaf once its detail is open.
  const detailTitle = selectedLeaf
    ? (selectedLeaf.label ?? `Subagent ${selectedLeaf.seq}`)
    : "";
  const headerTitle = selectedLeaf ? detailTitle : title;

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
      {/* Breadcrumb — only shown once a leaf's nested detail is open; the
          top-level subagents list has no breadcrumb. The workflow crumb is a
          button that returns to the list, mirroring the header Back button. */}
      {selectedLeaf && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-hover)] px-5 py-3">
          <button
            type="button"
            onClick={handleBack}
            title={title}
            className="min-w-0 shrink cursor-pointer truncate text-left text-[var(--content-default)] hover:underline"
          >
            <Typography variant="body-small-default" as="span">
              {title}
            </Typography>
          </button>
          <ChevronRight
            className="h-2.5 w-2.5 shrink-0 text-[var(--content-tertiary)]"
            aria-hidden
          />
          <Typography
            variant="body-small-default"
            as="span"
            title={detailTitle}
            className="min-w-0 shrink truncate text-[var(--content-secondary)]"
          >
            {detailTitle}
          </Typography>
        </div>
      )}

      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-hover)] px-5 py-4">
        {selectedLeaf && (
          <Button
            variant="outlined"
            iconOnly={<ArrowLeft />}
            onClick={handleBack}
            aria-label="Back to subagents"
            tooltip="Back"
            className="shrink-0 rounded-lg"
          />
        )}
        {selectedLeaf ? (
          components && selectedTraits ? (
            <AvatarRenderer
              components={components}
              bodyShapeId={selectedTraits.bodyShape}
              eyeStyleId={selectedTraits.eyeStyle}
              colorId={selectedTraits.color}
              size={32}
            />
          ) : (
            <div style={{ width: 32, height: 32, flexShrink: 0 }} aria-hidden />
          )
        ) : (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] bg-[var(--surface-overlay)]">
            <Workflow
              className="h-4 w-4"
              style={{ color: "var(--content-secondary)" }}
            />
          </div>
        )}
        <Typography
          variant="title-medium"
          title={headerTitle}
          className="min-w-0 shrink truncate text-[var(--content-default)]"
        >
          {headerTitle}
        </Typography>
        {selectedLeaf ? (
          <WorkflowLeafStatusBadge status={selectedLeaf.status} />
        ) : (
          <WorkflowStatusBadge status={entry.status} />
        )}
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

      {/* Scrollable body — swaps to a leaf's nested detail when one is open,
          keeping the header above mounted in both views. */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
        <motion.div
          key={selectedLeaf ? String(selectedLeaf.seq) : "list"}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={
            reduce
              ? { duration: 0 }
              : { duration: 0.18, ease: [0.16, 1, 0.3, 1] }
          }
        >
          {selectedLeaf ? (
            <WorkflowLeafDetail leaf={selectedLeaf} />
          ) : (
            <>
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
                        onSelect={() => setSelectedLeafSeq(leaf.seq)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </motion.div>
      </div>
    </div>
  );
}

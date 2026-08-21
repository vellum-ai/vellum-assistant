import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronLeft,
  ChevronRight,
  Users,
  Workflow,
} from "lucide-react";

import { useCallback, useEffect, useState } from "react";

import { motion, useReducedMotion } from "motion/react";

import { AvatarRenderer } from "@/components/avatar-renderer";
import { DetailShell } from "@/components/detail-shell";
import { DetailPanelStopButton } from "@/domains/chat/components/detail-panel-stop-button";
import {
  AnimatedMetricCard,
  formatNumber,
} from "@/domains/chat/components/metric-card";
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
import { useTranslation } from "@/i18n";

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
  const { t } = useTranslation("chat");
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
    <DetailShell
      headerAbove={
        // Breadcrumb: only shown once a leaf's nested detail is open; the
        // top-level subagents list has no breadcrumb. The workflow crumb is a
        // button that returns to the list, mirroring the header Back button.
        selectedLeaf && (
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
        )
      }
      icon={
        <>
          {selectedLeaf && (
            <Button
              variant="outlined"
              iconOnly={<ChevronLeft />}
              onClick={handleBack}
              aria-label={t("workflowDetailPanel.backToSubagentsAria")}
              tooltip={t("workflowDetailPanel.back")}
              className="shrink-0"
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
            // Bare 20px glyph, matching what `DetailShellHeader` renders for a
            // `Glyph` prop, so this header's icon box lines up with the other
            // panels'. The leaf branch above keeps its 32px avatar.
            <Workflow
              className="h-5 w-5 shrink-0 text-[var(--content-secondary)]"
              aria-hidden
            />
          )}
        </>
      }
      title={headerTitle}
      headerTrailing={
        selectedLeaf ? (
          <WorkflowLeafStatusBadge status={selectedLeaf.status} />
        ) : (
          <WorkflowStatusBadge status={entry.status} />
        )
      }
      headerActions={
        isRunning && onStop ? (
          <DetailPanelStopButton
            onStop={() => onStop(entry.runId)}
            ariaLabel={t("workflowDetailPanel.stopWorkflow")}
          />
        ) : undefined
      }
      closeLabel={t("workflowDetailPanel.closeDetail")}
      onClose={onClose}
    >
      {/* Body: swaps to a leaf's nested detail when one is open, keeping the
          header above mounted in both views. */}
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
                  label={t("workflowDetailPanel.input")}
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
                  label={t("workflowDetailPanel.output")}
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
                  label={t("workflowDetailPanel.agents")}
                />
              </div>

              {/* Subagents section */}
              <div>
                <Typography
                  variant="body-medium-default"
                  as="h3"
                  className="mb-4 text-[var(--content-emphasised)]"
                >
                  {t("workflowDetailPanel.subagents")}
                </Typography>
                {sortedLeaves.length === 0 ? (
                  <Typography
                    variant="body-small-default"
                    className="py-4 text-center text-[var(--content-tertiary)]"
                  >
                    {t("workflowDetailPanel.noSubagentsYet")}
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
    </DetailShell>
  );
}

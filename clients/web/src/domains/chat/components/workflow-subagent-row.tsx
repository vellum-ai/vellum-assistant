import type { ReactNode } from "react";

import { Ban, CircleCheck, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { Typography } from "@vellumai/design-library";

import { AvatarRenderer } from "@/components/avatar-renderer";
import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import type { WorkflowLeaf } from "@/domains/chat/workflow-store";
import type { CharacterComponents } from "@/types/avatar";
import { subagentTraits } from "@/utils/avatar-subagent";

/**
 * Lead glyph for a subagent row: the pulsing three-dot "running" indicator
 * while the leaf is in flight, otherwise a compact terminal status icon.
 */
function LeadIndicator({ status }: { status: WorkflowLeaf["status"] }) {
  const reduce = useReducedMotion();
  const baseClass = "h-3.5 w-3.5 shrink-0";

  let icon: ReactNode;
  if (status === "running") {
    icon = <ThreeDotIndicator className="shrink-0" dotSize={4} gap={2} />;
  } else if (status === "completed") {
    icon = (
      <CircleCheck
        className={baseClass}
        style={{ color: "var(--system-positive-strong)" }}
      />
    );
  } else if (status === "failed") {
    icon = (
      <TriangleAlert
        className={baseClass}
        style={{ color: "var(--system-negative-strong)" }}
      />
    );
  } else {
    icon = (
      <Ban
        className={baseClass}
        style={{ color: "var(--content-secondary)" }}
        role="img"
        aria-label="Cancelled"
      />
    );
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={status}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={
          reduce
            ? { duration: 0 }
            : { duration: 0.15, ease: [0.16, 1, 0.3, 1] }
        }
        className="flex shrink-0 items-center"
      >
        {icon}
      </motion.span>
    </AnimatePresence>
  );
}

export interface WorkflowSubagentRowProps {
  runId: string;
  leaf: WorkflowLeaf;
  /** Bundled avatar SVG components, or `null` until the lazy chunk resolves. */
  components: CharacterComponents | null;
  /** Opens this leaf's nested detail view in the panel. */
  onSelect: () => void;
}

/**
 * One row in the workflow panel's "Subagents" list — lead indicator, a
 * deterministic avatar (seeded by `runId:seq` so each leaf gets a stable,
 * distinct creature), the leaf's task name, a faint divider, and the leaf's
 * latest activity.
 *
 * The trailing "N steps" count and a live, carouseling activity line are
 * intentionally absent here: the daemon emits no per-leaf step/progress data
 * today (leaves are not subagents and carry no event timeline). The static
 * activity text below is the leaf's prompt summary. When the daemon grows
 * per-leaf progress events, render the step count on the right and swap the
 * static text for the shared `HeaderStepCarousel` — this row is the seam.
 */
export function WorkflowSubagentRow({
  runId,
  leaf,
  components,
  onSelect,
}: WorkflowSubagentRowProps) {
  const title = leaf.label ?? `Subagent ${leaf.seq}`;
  const activity = leaf.promptSummary;
  // Seed the avatar off the run + seq (leaves have no subagent id); the same
  // leaf always renders the same avatar.
  const traits = subagentTraits(`${runId}:${leaf.seq}`);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Open ${title} details`}
      className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-[6px] px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-overlay)]"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <LeadIndicator status={leaf.status} />
        {components ? (
          <AvatarRenderer
            components={components}
            bodyShapeId={traits.bodyShape}
            eyeStyleId={traits.eyeStyle}
            colorId={traits.color}
            size={16}
          />
        ) : (
          <div style={{ width: 16, height: 16, flexShrink: 0 }} aria-hidden />
        )}
        <Typography
          variant="body-medium-default"
          title={title}
          // Keep the task name at its natural width so short labels stay whole
          // (the muted activity to its right is what truncates), but cap it so a
          // pathologically long generated label ellipsizes within the 400px panel
          // instead of overflowing the row.
          className="max-w-[60%] shrink-0 truncate text-[var(--content-default)]"
        >
          {title}
        </Typography>
        {activity && (
          <>
            <span
              aria-hidden
              className="shrink-0 text-[var(--content-tertiary)] opacity-10"
            >
              |
            </span>
            <Typography
              variant="body-medium-lighter"
              title={activity}
              className="min-w-0 truncate text-[var(--content-tertiary)]"
            >
              {activity}
            </Typography>
          </>
        )}
      </div>
    </button>
  );
}

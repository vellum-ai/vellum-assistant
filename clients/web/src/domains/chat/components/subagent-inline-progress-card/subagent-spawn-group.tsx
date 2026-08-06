// Collapsible wrapper for a set of spawned subagents: the SubagentAvatarRow
// summary when collapsed, the generic inline-process card list when expanded.

import { ChevronUp } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";

import { SubagentAvatarRow } from "@/domains/chat/components/subagent-inline-progress-card/subagent-avatar-row";
import { SUBAGENT_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/subagent";
import { InlineProcessCardRow } from "@/domains/chat/process-registry/inline-process-card-row";

export interface SubagentSpawnGroupProps {
  subagentIds: string[];
  onSubagentClick?: (subagentId: string) => void;
  onStopSubagent?: (subagentId: string) => void;
}

export function SubagentSpawnGroup({
  subagentIds,
  onSubagentClick,
  onStopSubagent,
}: SubagentSpawnGroupProps) {
  // Default collapsed — the avatar summary is the resting state in the mocks.
  const [expanded, setExpanded] = useState(false);
  const reduce = useReducedMotion();

  // Expanding mounts one `InlineProcessCardRow` per member, and each row's
  // `useSubagentCardData` fetches its own timeline on mount if it's missing
  // (rendering is the demand signal). The collapsed avatar summary mounts no
  // card data, so nothing fetches on load.
  const handleExpand = () => setExpanded(true);

  if (subagentIds.length === 0) {
    return null;
  }

  const transition = reduce
    ? { duration: 0 }
    : { duration: 0.2, ease: [0.16, 1, 0.3, 1] as const };

  return (
    <AnimatePresence mode="wait" initial={false}>
      {!expanded ? (
        <motion.div
          key="collapsed"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={transition}
        >
          <SubagentAvatarRow
            subagentIds={subagentIds}
            onExpand={handleExpand}
          />
        </motion.div>
      ) : (
        <motion.div
          key="expanded"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={transition}
          className="flex w-full flex-col"
        >
          <div className="flex w-full flex-col gap-1">
            {subagentIds.map((id) => (
              <InlineProcessCardRow
                key={id}
                descriptor={SUBAGENT_DESCRIPTOR}
                id={id}
                onOpen={onSubagentClick ? () => onSubagentClick(id) : undefined}
                onStop={onStopSubagent ? () => onStopSubagent(id) : undefined}
                stopAriaLabel="Stop subagent"
                testId="inline-process-card"
              />
            ))}
          </div>

          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="Collapse subagent details"
            data-testid="subagent-spawn-group-collapse"
            // Matches the SubagentAvatarRow "Details" twin.
            className="mt-2 flex cursor-pointer items-center gap-1 text-[13px] font-medium text-[var(--content-secondary)]"
          >
            Collapse
            <ChevronUp className="h-3 w-3 text-[var(--content-tertiary)]" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

import clsx from "clsx";
import { ChevronDown, ChevronUp } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { AcpAgentIcon } from "@/domains/chat/components/acp-run-inline-card/acp-agent-icon";
import { ChatPill } from "@/domains/chat/components/chat-pill";

// Visible agent-mark cap before the "+N" overflow, mirroring the subagents pill.
const MAX_VISIBLE_ACP_AGENTS = 6;

export interface ActiveAcpRunsPillProps {
  acpRunIds: string[];
  expanded: boolean;
  onToggle: () => void;
}

/** A single stacked brand mark for one run, keyed off its backing agent. */
function AcpAgentChip({
  acpSessionId,
  className,
}: {
  acpSessionId: string;
  className?: string;
}) {
  const agent = useAcpRunStore((s) => s.byId[acpSessionId]?.agent);
  return (
    <span
      className={clsx(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--surface-base)]",
        className,
      )}
    >
      <AcpAgentIcon agent={agent} className="h-3 w-3" />
    </span>
  );
}

export function ActiveAcpRunsPill({
  acpRunIds,
  expanded,
  onToggle,
}: ActiveAcpRunsPillProps) {
  const visibleIds = acpRunIds.slice(0, MAX_VISIBLE_ACP_AGENTS);
  const overflowCount = acpRunIds.length - MAX_VISIBLE_ACP_AGENTS;

  return (
    <ChatPill
      onClick={onToggle}
      ariaLabel="Active runs"
      ariaExpanded={expanded}
      size="compact"
    >
      {/* pointer-events-none so the ChatPill button owns clicks + cursor. */}
      <span className="pointer-events-none inline-flex items-center gap-2">
        <span className="flex items-center">
          {visibleIds.map((id, index) => (
            <AcpAgentChip
              key={id}
              acpSessionId={id}
              className={
                index === 0
                  ? undefined
                  : "-ml-1 ring-2 ring-[var(--surface-lift)]"
              }
            />
          ))}
        </span>

        {overflowCount > 0 && (
          <Typography
            variant="body-small-default"
            className="text-[var(--content-emphasised)]"
          >
            +{overflowCount}
          </Typography>
        )}

        {expanded ? (
          <ChevronUp className="h-3 w-3 text-[var(--content-tertiary)]" />
        ) : (
          <ChevronDown className="h-3 w-3 text-[var(--content-tertiary)]" />
        )}
      </span>
    </ChatPill>
  );
}

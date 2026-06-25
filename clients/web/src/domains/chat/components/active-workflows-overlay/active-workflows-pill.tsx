import { ChevronDown, ChevronUp, Workflow } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import { ChatPill } from "@/domains/chat/components/chat-pill";

export interface ActiveWorkflowsPillProps {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}

export function ActiveWorkflowsPill({
  count,
  expanded,
  onToggle,
}: ActiveWorkflowsPillProps) {
  return (
    <ChatPill
      onClick={onToggle}
      ariaLabel={`${count} active workflow${count === 1 ? "" : "s"}`}
      ariaExpanded={expanded}
      size="compact"
    >
      {/* pointer-events-none so the ChatPill button owns clicks + cursor — clicking anywhere toggles. */}
      <span className="pointer-events-none inline-flex items-center gap-1.5">
        <Workflow
          className="h-4 w-4 shrink-0 text-[var(--content-secondary)]"
          aria-hidden
        />
        <Typography
          variant="body-small-default"
          className="text-[var(--content-emphasised)]"
        >
          {count}
        </Typography>
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]" aria-hidden />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]" aria-hidden />
        )}
      </span>
    </ChatPill>
  );
}

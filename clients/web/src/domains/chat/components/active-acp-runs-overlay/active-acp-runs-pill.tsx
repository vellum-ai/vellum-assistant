import { ChevronDown, ChevronUp, Code } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import { ChatPill } from "@/domains/chat/components/chat-pill";

export interface ActiveAcpRunsPillProps {
  acpRunIds: string[];
  expanded: boolean;
  onToggle: () => void;
}

export function ActiveAcpRunsPill({
  acpRunIds,
  expanded,
  onToggle,
}: ActiveAcpRunsPillProps) {
  return (
    <ChatPill
      onClick={onToggle}
      ariaLabel="Active runs"
      ariaExpanded={expanded}
      size="compact"
    >
      {/* pointer-events-none so the ChatPill button owns clicks + cursor. */}
      <span className="pointer-events-none inline-flex items-center gap-2">
        <Code className="h-4 w-4 text-[var(--content-emphasised)]" />

        <Typography
          variant="body-small-default"
          className="text-[var(--content-emphasised)]"
        >
          {acpRunIds.length}
        </Typography>

        {expanded ? (
          <ChevronUp className="h-3 w-3 text-[var(--content-tertiary)]" />
        ) : (
          <ChevronDown className="h-3 w-3 text-[var(--content-tertiary)]" />
        )}
      </span>
    </ChatPill>
  );
}

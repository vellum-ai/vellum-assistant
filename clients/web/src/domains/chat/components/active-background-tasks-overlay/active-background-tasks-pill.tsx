import { ChevronDown, ChevronUp } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import { BackgroundTaskGlyph } from "@/domains/chat/components/background-task-glyph";
import { ChatPill } from "@/domains/chat/components/chat-pill";
import { useBackgroundTaskStore } from "@/domains/chat/background-task-store";

/** Cap on stacked terminal glyphs before collapsing the remainder to "+N". */
const MAX_VISIBLE_BACKGROUND_TASK_GLYPHS = 6;

export interface ActiveBackgroundTasksPillProps {
  taskIds: string[];
  expanded: boolean;
  onToggle: () => void;
}

export function ActiveBackgroundTasksPill({
  taskIds,
  expanded,
  onToggle,
}: ActiveBackgroundTasksPillProps) {
  const visibleIds = taskIds.slice(0, MAX_VISIBLE_BACKGROUND_TASK_GLYPHS);
  const overflowCount = taskIds.length - MAX_VISIBLE_BACKGROUND_TASK_GLYPHS;
  // Per-task glyph (host_bash → file-terminal, bash → square-terminal); look up
  // the tool by id from the store since the pill only receives ids.
  const byId = useBackgroundTaskStore((s) => s.byId);

  return (
    <ChatPill
      onClick={onToggle}
      ariaLabel="Active commands"
      ariaExpanded={expanded}
      size="compact"
    >
      {/* pointer-events-none so the ChatPill button owns clicks + cursor — clicking any glyph toggles. */}
      <span className="pointer-events-none inline-flex items-center gap-2">
        <span className="flex items-center">
          {visibleIds.map((id, index) => (
            // surface-lift fill + matching ring notches each overlapping glyph
            // off the one behind it (the pill is also surface-lift), so the
            // stack reads as separate cards rather than superimposed strokes.
            <span
              key={id}
              className={`flex h-4 w-4 items-center justify-center rounded bg-[var(--surface-lift)] ${
                index === 0 ? "" : "-ml-1 ring-2 ring-[var(--surface-lift)]"
              }`}
            >
              <BackgroundTaskGlyph
                toolName={byId[id]?.toolName ?? "bash"}
                className="h-3.5 w-3.5 text-[var(--content-emphasised)]"
              />
            </span>
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

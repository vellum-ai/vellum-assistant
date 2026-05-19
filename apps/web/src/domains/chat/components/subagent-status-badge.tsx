import type { SubagentStatus } from "@/domains/chat/lib/event-types.js";
import {
  statusColor,
  statusLabel,
} from "@/domains/chat/lib/subagent-status-helpers.js";

export function StatusBadge({ status }: { status: SubagentStatus }) {
  const color = statusColor(status);
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-label-small-default"
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
      }}
    >
      {statusLabel(status)}
    </span>
  );
}

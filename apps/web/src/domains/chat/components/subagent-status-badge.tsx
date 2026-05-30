import type { SubagentStatus } from "@vellumai/assistant-api";
import {
  statusColor,
  statusLabel,
} from "@/utils/subagent-status";

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

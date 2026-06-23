import type { SubagentStatus } from "@vellumai/assistant-api";
import {
  statusColor,
  statusLabel,
} from "@/utils/subagent-status";

export function StatusBadge({ status }: { status: SubagentStatus }) {
  const color = statusColor(status);
  // `rounded-[6px]` and `h-[23px]` match the Figma mock (node 6063-150536) —
  // deliberately more rectangular than the design scale's `--radius-md` (8px).
  // The scale has no 6px token (sm=4, md=8), hence the explicit arbitrary
  // values; the fixed height pins the badge to the mock rather than letting the
  // line-height + padding determine it.
  return (
    <span
      className="inline-flex h-[23px] shrink-0 items-center gap-1 rounded-[6px] px-2 text-label-small-default"
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
      }}
    >
      {statusLabel(status)}
    </span>
  );
}

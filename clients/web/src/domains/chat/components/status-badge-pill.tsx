/**
 * Shared status-badge pill — the presentational shell behind both
 * `StatusBadge` (subagent) and `WorkflowStatusBadge` (workflow). Each wrapper
 * resolves its own status enum's `statusColor`/`statusLabel` and feeds them in,
 * so the two badges are guaranteed identical in size and shape.
 *
 * `h-[23px]` and `rounded-[6px]` match the Figma mock (node 6063-150536) —
 * deliberately more rectangular than the design scale's `--radius-md` (8px).
 * The scale has no 6px token (sm=4, md=8), hence the explicit arbitrary values;
 * the fixed height pins the badge to the mock rather than letting the
 * line-height + padding determine it.
 */
export function StatusBadgePill({
  color,
  label,
}: {
  color: string;
  label: string;
}) {
  return (
    <span
      className="inline-flex h-[23px] shrink-0 items-center gap-1 rounded-[6px] px-2 text-body-small-emphasised"
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
      }}
    >
      {label}
    </span>
  );
}


/**
 * Mirrors macOS VBusyIndicator.
 *
 * A filled circle that gently pulses in opacity (1→0.3) and scale (1→0.85)
 * over 1s easeInOut. Respects prefers-reduced-motion via the
 * `.busy-indicator` CSS class defined in `apps/web/src/index.css`.
 *
 * Size guide (matching macOS usage):
 *   - 8px  — card-header status icon (MultiActivityGroup CardStatusIcon)
 *   - 6px  — per-step row icon (ToolCallChip StatusIcon, ThinkingRow)
 */
export function BusyIndicator({ size = 8 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="busy-indicator inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        backgroundColor: "var(--primary-base)",
      }}
    />
  );
}

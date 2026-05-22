import { SubagentDetailPanel } from "@/domains/chat/components/subagent-detail-panel.js";
import type { SubagentEntry } from "@/domains/subagents/subagent-store.js";

interface MobileSubagentDetailOverlayProps {
  /** When `null`, the overlay renders nothing. */
  entry: SubagentEntry | null;
  /** Closes the overlay. */
  onClose: () => void;
  /** Stop a running subagent. */
  onStop?: (subagentId: string) => void;
  /** Request detail fetch for a subagent. */
  onRequestDetail?: (subagentId: string) => void;
}

/**
 * Mobile-only full-screen overlay that hosts the subagent detail panel.
 *
 * **Mounting constraint**: must render outside `RootLayout`'s inner
 * transformed wrapper (see `src/root-layout.tsx`) so
 * `position: fixed` anchors to the viewport's initial containing block
 * rather than the keyboard-following transform `RootLayout` applies when
 * the soft keyboard opens.
 *
 * https://www.w3.org/TR/css-transforms-1/#transform-rendering
 */
export function MobileSubagentDetailOverlay({
  entry,
  onClose,
  onStop,
  onRequestDetail,
}: MobileSubagentDetailOverlayProps) {
  if (!entry) {
    return null;
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 h-[100dvh]">
      <SubagentDetailPanel
        entry={entry}
        onClose={onClose}
        onStop={onStop}
        onRequestDetail={onRequestDetail}
      />
    </div>
  );
}

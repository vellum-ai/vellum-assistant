import { lazy } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
import type { MessageFilesPayload } from "@/stores/viewer-store";

const MessageFilesPanel = lazy(() =>
  import("@/domains/chat/components/message-files-panel").then((m) => ({
    default: m.MessageFilesPanel,
  })),
);

interface MobileMessageFilesOverlayProps {
  /** When `null`, the overlay renders nothing. */
  payload: MessageFilesPayload | null;
  /** Closes the overlay. */
  onClose: () => void;
}

/**
 * Mobile-only full-screen overlay that hosts the message-files panel (every
 * attachment on one transcript message, each opening the shared preview
 * modal).
 *
 * **Mounting constraint**: must render inside `RootLayout`'s
 * `#viewport-overlays` portal, outside the main content wrapper.
 */
export function MobileMessageFilesOverlay({
  payload,
  onClose,
}: MobileMessageFilesOverlayProps) {
  const shellStyle = useMobileOverlayViewportStyle();

  if (!payload) {
    return null;
  }

  return (
    <div className="fixed inset-x-0 z-30" style={shellStyle}>
      <LazyBoundary>
        {/* Re-key per message so switching targets remounts the panel rather
            than reusing one whose internal preview state belongs to the
            previous message. */}
        <MessageFilesPanel
          key={payload.messageId}
          payload={payload}
          onClose={onClose}
        />
      </LazyBoundary>
    </div>
  );
}

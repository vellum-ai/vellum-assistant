/**
 * Mobile-only full-screen host for the channel transcript panel.
 *
 * `AnimatedRightDrawer` is a desktop split that overflows narrow viewports, so
 * the drawer stays closed there and the panel arrives through the same
 * `#viewport-overlays` portal every other chat detail surface uses. No
 * permanent split, no second overlay system.
 *
 * **Mounting constraint**: must render inside `RootLayout`'s
 * `#viewport-overlays` portal, outside the main content wrapper.
 */

import { lazy } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
import type { ChannelSidecarRef } from "@/stores/viewer-store";

const ChannelTranscriptPanel = lazy(() =>
  import("@/domains/chat/channel-sidecar/channel-transcript-panel").then(
    (m) => ({ default: m.ChannelTranscriptPanel }),
  ),
);

interface MobileChannelTranscriptOverlayProps {
  /** When `null`, the overlay renders nothing. */
  sidecarRef: ChannelSidecarRef | null;
  onClose: () => void;
}

export function MobileChannelTranscriptOverlay({
  sidecarRef,
  onClose,
}: MobileChannelTranscriptOverlayProps) {
  const shellStyle = useMobileOverlayViewportStyle();

  if (!sidecarRef) {
    return null;
  }

  return (
    <div className="fixed inset-x-0 z-30" style={shellStyle}>
      <LazyBoundary>
        {/* Re-key per thread so switching conversations remounts the panel
            instead of reusing one whose scroll position belongs to the
            previous thread. */}
        <ChannelTranscriptPanel
          key={`${sidecarRef.conversationId}:${sidecarRef.channelId}`}
          sidecarRef={sidecarRef}
          onClose={onClose}
        />
      </LazyBoundary>
    </div>
  );
}

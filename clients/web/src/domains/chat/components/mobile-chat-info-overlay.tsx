import { lazy } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
import type { ChatInfoCategory, ChatInfoPayload } from "@/stores/viewer-store";
import { chatInfoTargetKey } from "@/stores/viewer-store";

const ChatInfoPanel = lazy(() =>
  import("@/domains/chat/components/chat-info-panel").then((m) => ({
    default: m.ChatInfoPanel,
  })),
);

interface MobileChatInfoOverlayProps {
  /** When `null`, the overlay renders nothing. */
  payload: ChatInfoPayload | null;
  /** Closes the overlay. */
  onClose: () => void;
  /** See All drills in with a category; the back control passes `null`. */
  onSelectCategory: (category: ChatInfoCategory | null) => void;
}

/**
 * Mobile-only full-screen overlay that hosts the chat-info panel (one
 * conversation's apps, documents and images, and camera frames, each category
 * drilling into its own See All level).
 *
 * **Mounting constraint**: must render inside `RootLayout`'s
 * `#viewport-overlays` portal, outside the main content wrapper.
 */
export function MobileChatInfoOverlay({
  payload,
  onClose,
  onSelectCategory,
}: MobileChatInfoOverlayProps) {
  const shellStyle = useMobileOverlayViewportStyle();

  if (!payload) {
    return null;
  }

  return (
    <div className="fixed inset-x-0 z-30" style={shellStyle}>
      <LazyBoundary>
        {/* Re-key per target so a switch remounts the panel rather than
            reusing one whose preview and delete state belong to the previous
            chat. */}
        <ChatInfoPanel
          key={chatInfoTargetKey(payload)}
          payload={payload}
          onClose={onClose}
          onSelectCategory={onSelectCategory}
        />
      </LazyBoundary>
    </div>
  );
}

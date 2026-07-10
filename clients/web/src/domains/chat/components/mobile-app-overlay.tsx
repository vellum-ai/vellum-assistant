import { useCallback, type CSSProperties } from "react";

import { AppViewerContainer } from "@/components/app-viewer-container";
import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
import { useSwipeVertical } from "@/hooks/use-swipe-vertical";
import { cn } from "@/utils/misc";
import type { OpenedAppState } from "@/stores/viewer-store";

interface MobileAppOverlayProps {
  /** When `null`, the overlay renders nothing. */
  openedAppState: OpenedAppState | null;
  /** Controls the slide-down-to-strip animation. */
  isAppMinimized: boolean;
  /**
   * Assistant id consumed by `AppViewerContainer`. Defaults to empty string
   * upstream when no assistant is selected; callers should pass the resolved
   * id (or `null` to coerce to empty).
   */
  assistantId: string | null;
  /** Toggles the slide-down minimize/restore animation. */
  onToggleMinimized: () => void;
  /** Closes the overlay (resets `openedAppState` upstream). */
  onClose: () => void;
  /** Initiates app share flow. */
  onShare: () => void;
  isSharing: boolean;
  /** Optional one-click deploy handler; omitted when org has not opted in. */
  onDeploy?: () => void;
  isDeploying: boolean;
  /** Deep-link route to forward to the iframe (`window.vellum.route`). */
  route?: string;
  /** Forwarded to `AppViewerContainer` for sandboxed app actions. */
  onAction?: (actionId: string, data?: Record<string, unknown>) => void;
}

/**
 * Mobile-only full-screen overlay that hosts the generated app viewer.
 * Slides up over the chat surface and animates down to a thin strip when
 * minimized (`isAppMinimized=true`) so the chat behind becomes interactive
 * again.
 *
 * **Mounting constraint**: must render inside `RootLayout`'s
 * `#viewport-overlays` portal, outside the main content wrapper.
 */
export function MobileAppOverlay({
  openedAppState,
  isAppMinimized,
  assistantId,
  onToggleMinimized,
  onClose,
  onShare,
  isSharing,
  onDeploy,
  isDeploying,
  route,
  onAction,
}: MobileAppOverlayProps) {
  const shellStyle = useMobileOverlayViewportStyle();

  // Swipe-down on the full overlay minimizes to the strip; swipe-up on the
  // minimized strip restores; swipe-down on the strip closes entirely. These
  // trigger the same callbacks the nav-bar buttons use — no new state.
  const handleSwipeDown = useCallback(() => {
    if (isAppMinimized) {
      onClose();
    } else {
      onToggleMinimized();
    }
  }, [isAppMinimized, onClose, onToggleMinimized]);

  const handleSwipeUp = useCallback(() => {
    if (isAppMinimized) {
      onToggleMinimized();
    }
  }, [isAppMinimized, onToggleMinimized]);

  const {
    dragOffset,
    isDragging,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
  } = useSwipeVertical({
    enabled: !!openedAppState,
    onSwipeDown: handleSwipeDown,
    onSwipeUp: handleSwipeUp,
  });

  if (!openedAppState) {
    return null;
  }

  return (
    <div
      className={cn(
        "fixed inset-x-0 z-30 transition-transform duration-300 ease-out",
        // While minimized, the shell's transparent safe-area padding band
        // sits directly above the visible strip — over the lifted composer —
        // so the shell must not hit-test; the inner sheet wrapper (which
        // starts below the padding) re-enables pointer events for the strip.
        isAppMinimized && "pointer-events-none",
      )}
      style={{
        ...shellStyle,
        // `--drag-y` is 0 at rest and tracks the finger during a swipe. It
        // composes with the resting translateY so the overlay follows the
        // finger, then springs back (or animates to the new resting state on
        // commit) when the transition re-enables.
        "--drag-y": `${dragOffset}px`,
        transform: isAppMinimized
          ? "translateY(calc(100% - var(--app-strip-h, 64px) - var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) - var(--overlay-safe-area-bottom, 0px) + var(--drag-y, 0px)))"
          : "translateY(var(--drag-y, 0px))",
        // Disable the CSS transition while dragging so the overlay tracks the
        // finger 1:1; re-enable it on release for the spring-back / commit
        // animation.
        transition: isDragging ? "none" : undefined,
      } as CSSProperties}
    >
      {/* The minimized strip overlays the chat, so it needs a top-directional
          shadow to read as a layer above it. The shadow lives on this inner
          wrapper — not the outer fixed box — because the outer box's
          `paddingTop` (safe-area inset) would paint the shadow above the
          sheet's visible top edge. */}
      <div
        className={cn(
          "h-full rounded-xl",
          isAppMinimized &&
            "pointer-events-auto shadow-[0_-4px_16px_rgba(0,0,0,0.15)]",
        )}
        // Claim vertical gestures for the swipe; let the browser handle
        // horizontal pans natively. Touches inside the sandboxed app iframe
        // are governed by the iframe's own document and are unaffected.
        style={{ touchAction: "pan-x" }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      >
        <AppViewerContainer
          appId={openedAppState.appId}
          appName={openedAppState.name}
          html={openedAppState.html}
          assistantId={assistantId ?? ""}
          onClose={onClose}
          onEdit={onToggleMinimized}
          onShare={onShare}
          isSharing={isSharing}
          onDeploy={onDeploy}
          isDeploying={isDeploying}
          isEditing={isAppMinimized}
          route={route}
          onAction={onAction}
        />
      </div>
    </div>
  );
}

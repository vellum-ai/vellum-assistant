import { AppViewerContainer } from "@/components/app-viewer-container";
import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
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

  if (!openedAppState) {
    return null;
  }

  return (
    <div
      className="fixed inset-x-0 z-30 transition-transform duration-300 ease-out"
      style={{
        ...shellStyle,
        transform: isAppMinimized
          ? "translateY(calc(100% - var(--app-strip-h, 56px) - var(--safe-area-inset-top, env(safe-area-inset-top, 0px))))"
          : "translateY(0)",
      }}
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
  );
}

import { AppViewerContainer } from "@/components/app-viewer-container";
import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
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

  if (!openedAppState) {
    return null;
  }

  return (
    <div
      className={cn(
        "fixed inset-x-0 z-30 transition-transform duration-300 ease-out",
        // The minimized strip overlays the chat, so it needs a
        // top-directional shadow to read as a layer above it rather than
        // blending in.
        isAppMinimized && "shadow-[0_-4px_16px_rgba(0,0,0,0.15)]",
      )}
      style={{
        ...shellStyle,
        // Minimized: slide down until only the nav bar peeks above the bottom
        // edge. The bar is 64px tall on mobile (`py-3` 24px + 40px
        // `touch-mobile:` buttons). Both insets the shell's padding applies
        // must be subtracted: the top inset because `paddingTop` shifts the
        // content down, and the hook's effective bottom inset
        // (`--overlay-safe-area-bottom`) so the strip clears the iOS home
        // indicator while the keyboard is closed yet sits flush on the
        // keyboard while it's open (the hook zeroes the inset then).
        transform: isAppMinimized
          ? "translateY(calc(100% - var(--app-strip-h, 64px) - var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) - var(--overlay-safe-area-bottom, 0px)))"
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

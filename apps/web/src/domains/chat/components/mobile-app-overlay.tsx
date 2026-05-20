import { AppViewerContainer } from "@/domains/chat/components/app-viewer-container.js";
import type { OpenedAppState } from "@/stores/viewer-store.js";

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
}

/**
 * Mobile-only full-screen overlay that hosts the generated app viewer.
 * Slides up over the chat surface and animates down to a thin strip when
 * minimized (`isAppMinimized=true`) so the chat behind becomes interactive
 * again.
 *
 * Rendered through the assistant shell's viewport-overlay slot, which places
 * it as a sibling of the shell's transformed inner wrapper. That sibling
 * position keeps `position: fixed` anchored to the viewport's initial
 * containing block rather than the keyboard-following shell transform.
 *
 * https://www.w3.org/TR/css-transforms-1/#transform-rendering
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
}: MobileAppOverlayProps) {
  if (!openedAppState) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 h-[100dvh] transition-transform duration-300 ease-out"
      style={{
        transform: isAppMinimized
          ? "translateY(calc(100% - var(--app-strip-h, 56px)))"
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
      />
    </div>
  );
}

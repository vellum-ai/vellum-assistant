import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Minimize2 } from "lucide-react";

import { AppNavBar } from "@/components/app-nav-bar";
import {
  copyDeployedAppLink,
  useAppDeployment,
} from "@/hooks/use-app-deployment";
import { useSandboxFetchProxy } from "@/hooks/use-sandbox-fetch-proxy";
import { useAppIframeSandboxDisabled } from "@/lib/app-sandbox-debug-flag";
import { cn } from "@/utils/misc";
import { injectBridge } from "@/utils/sandbox-bridge";
import { Button } from "@vellumai/design-library";

/**
 * Sandbox tokens the app frame runs under. No `allow-same-origin`, so the
 * app document is opaque-origin and reaches the host only through the
 * bridge in `@/utils/sandbox-bridge`.
 */
const APP_IFRAME_SANDBOX =
  "allow-scripts allow-popups allow-popups-to-escape-sandbox";

export interface AppViewerContainerProps {
  appId: string;
  appName: string;
  html: string;
  assistantId: string;
  onClose: () => void;
  onEdit?: () => void;
  /** When true, the nav bar Edit button becomes the expand-app affordance. */
  isEditing?: boolean;
  onShare?: () => void;
  isSharing?: boolean;
  onDeploy?: () => void;
  isDeploying?: boolean;
  /** Deep-link route passed to the app as `window.vellum.route`. */
  route?: string;
  /** Enables the fullscreen toggle (nav-bar button + fullscreen rendering). Default false. */
  enableFullscreen?: boolean;
  /**
   * Handler for actions the sandboxed app dispatches via
   * `window.vellum.sendAction(actionId, data)` (e.g. `relay_prompt`). The
   * viewer is presentational — the consumer owns what an action does. Omit it
   * (e.g. the standalone library viewer) to ignore app actions.
   */
  onAction?: (actionId: string, data?: Record<string, unknown>) => void;
}

export function AppViewerContainer({
  appId,
  appName,
  html,
  assistantId,
  onClose,
  onEdit,
  isEditing,
  onShare,
  isSharing,
  onDeploy,
  isDeploying,
  route,
  enableFullscreen = false,
  onAction,
}: AppViewerContainerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = useCallback(() => setIsFullscreen((v) => !v), []);

  // Reset fullscreen when the rendered app changes.
  useEffect(() => {
    setIsFullscreen(false);
  }, [appId]);

  // Escape-to-exit handler, active only while fullscreen.
  useEffect(() => {
    if (!isFullscreen) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        setIsFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFullscreen]);

  const srcdoc = useMemo(
    () => injectBridge(html, appId, { fetch: true, route }),
    [html, appId, route],
  );

  const sandboxDisabled = useAppIframeSandboxDisabled();

  // The sandbox flag is part of the key: a frame keeps the security
  // context it was created with, so flipping the attribute on a live
  // iframe changes nothing. Re-keying remounts it, which reloads the
  // document under the attribute in effect.
  const iframeKey = useMemo(() => {
    let hash = 0;
    for (let i = 0; i < html.length; i++) {
      hash = ((hash << 5) - hash + html.charCodeAt(i)) | 0;
    }
    return `app-${appId}-${hash}${sandboxDisabled ? "-nosandbox" : ""}`;
  }, [html, appId, sandboxDisabled]);

  useSandboxFetchProxy(iframeRef, {
    frameId: appId,
    assistantId,
    appId,
    onAction,
  });

  // Only asked for when the viewer actually offers a deploy: read-only
  // (plugin-bundled) apps get no deploy handler and so need no status read.
  const { deployedUrl } = useAppDeployment(assistantId, appId, {
    enabled: onDeploy != null,
  });
  const handleCopyDeployedLink = useCallback(() => {
    if (deployedUrl != null) {
      copyDeployedAppLink(deployedUrl);
    }
  }, [deployedUrl]);

  return (
    <div
      data-testid="app-viewer-root"
      className={cn(
        "flex flex-col overflow-hidden bg-[var(--surface-base)]",
        isFullscreen ? "fixed inset-0 z-[60]" : "h-full rounded-xl",
      )}
    >
      {!isFullscreen && (
        <AppNavBar
          appName={appName}
          onEdit={onEdit}
          isEditing={isEditing}
          onShare={onShare}
          isSharing={isSharing}
          onDeploy={onDeploy}
          isDeploying={isDeploying}
          deployedUrl={deployedUrl}
          onCopyDeployedLink={handleCopyDeployedLink}
          onToggleFullscreen={enableFullscreen ? toggleFullscreen : undefined}
          onClose={onClose}
        />
      )}

      <div className="relative min-h-0 flex-1">
        {isFullscreen && (
          <div
            className="absolute z-10"
            style={{
              top: "max(0.75rem, var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))",
              right:
                "max(0.75rem, var(--safe-area-inset-right, env(safe-area-inset-right, 0px)))",
            }}
          >
            <Button
              variant="primary"
              iconOnly={<Minimize2 />}
              onClick={toggleFullscreen}
              tooltip="Exit fullscreen"
            />
          </div>
        )}
        <iframe
          ref={iframeRef}
          key={iframeKey}
          srcDoc={srcdoc}
          sandbox={sandboxDisabled ? undefined : APP_IFRAME_SANDBOX}
          referrerPolicy="no-referrer"
          title={appName}
          className="h-full w-full border-none"
        />
      </div>
    </div>
  );
}

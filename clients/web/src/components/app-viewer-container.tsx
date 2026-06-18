import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { Minimize2 } from "lucide-react";

import { AppNavBar } from "@/components/app-nav-bar";
import { useSandboxFetchProxy } from "@/hooks/use-sandbox-fetch-proxy";
import { useConversationStore } from "@/stores/conversation-store";
import { cn } from "@/utils/misc";
import { routes } from "@/utils/routes";
import { injectBridge } from "@/utils/sandbox-bridge";
import { Button } from "@vellumai/design-library";

export interface AppViewerContainerProps {
  appId: string;
  appName: string;
  html: string;
  assistantId: string;
  onClose: () => void;
  onEdit?: () => void;
  /** When true, the nav bar Edit button shows "Close chat" instead. */
  isEditing?: boolean;
  onShare?: () => void;
  isSharing?: boolean;
  onDeploy?: () => void;
  isDeploying?: boolean;
  /** Deep-link route passed to the app as `window.vellum.route`. */
  route?: string;
  /** Enables the fullscreen toggle (nav-bar button + fullscreen rendering). Default false. */
  enableFullscreen?: boolean;
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
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFullscreen]);

  const srcdoc = useMemo(
    () => injectBridge(html, appId, { fetch: true, route }),
    [html, appId, route],
  );

  const iframeKey = useMemo(() => {
    let hash = 0;
    for (let i = 0; i < html.length; i++) {
      hash = ((hash << 5) - hash + html.charCodeAt(i)) | 0;
    }
    return `app-${appId}-${hash}`;
  }, [html, appId]);

  // Routes `relay_prompt` actions from sandboxed apps into the active
  // chat conversation via the `?prompt=` auto-send pathway (see
  // `use-auto-send-effects.ts`). The viewer stays open so the app and
  // conversation are visible side by side. No-op when no conversation
  // is active.
  const navigate = useNavigate();
  const handleAppAction = useCallback(
    (actionId: string, data?: Record<string, unknown>) => {
      if (actionId !== "relay_prompt") return;
      const prompt = typeof data?.prompt === "string" ? data.prompt : null;
      if (!prompt) return;
      const activeConversationId =
        useConversationStore.getState().activeConversationId;
      if (!activeConversationId) return;
      void navigate(
        `${routes.conversation(activeConversationId)}?prompt=${encodeURIComponent(prompt)}`,
      );
    },
    [navigate],
  );

  useSandboxFetchProxy(iframeRef, {
    frameId: appId,
    assistantId,
    onAction: handleAppAction,
  });

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
              right: "max(0.75rem, var(--safe-area-inset-right, env(safe-area-inset-right, 0px)))",
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
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          title={appName}
          className="h-full w-full border-none"
        />
      </div>
    </div>
  );
}

import { useMemo, useRef } from "react";

import { AppNavBar } from "@/components/app-nav-bar";
import { useSandboxFetchProxy } from "@/hooks/use-sandbox-fetch-proxy";
import { injectBridge } from "@/utils/sandbox-bridge";

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
}: AppViewerContainerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

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

  useSandboxFetchProxy(iframeRef, {
    frameId: appId,
    assistantId,
  });

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl bg-[var(--surface-base)]">
      <AppNavBar
        appName={appName}
        onEdit={onEdit}
        isEditing={isEditing}
        onShare={onShare}
        isSharing={isSharing}
        onDeploy={onDeploy}
        isDeploying={isDeploying}
        onClose={onClose}
      />

      <div className="relative min-h-0 flex-1">
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

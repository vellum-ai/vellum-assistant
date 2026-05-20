
import { useEffect, useMemo, useRef } from "react";

import { AppNavBar } from "@/components/app-nav-bar.js";
import { FETCH_PROXY_ALLOWED_PATH_RE, injectBridge } from "@/domains/chat/lib/app-bridge.js";
import { client } from "@/generated/api/client.gen.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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

  const srcdoc = useMemo(() => injectBridge(html, appId, route), [html, appId, route]);

  // Stable key that changes when HTML content changes, forcing iframe re-render
  const iframeKey = useMemo(() => {
    let hash = 0;
    for (let i = 0; i < html.length; i++) {
      hash = ((hash << 5) - hash + html.charCodeAt(i)) | 0;
    }
    return `app-${appId}-${hash}`;
  }, [html, appId]);

  // Fetch proxy message handler
  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || msg.appId !== appId) return;
      if (event.source !== iframeRef.current?.contentWindow) return;

      // Surface actions — no-op for now (no conversation-bound surface)
      if (msg.type === "vellum_surface_action") return;

      if (msg.type !== "vellum_fetch_request") return;

      const { callId, path, method, headers, body } = msg as {
        callId: string;
        path: string;
        method: string;
        headers: Record<string, string>;
        body: string | null;
      };

      const iframe = iframeRef.current;
      const sendResponse = (response: Record<string, unknown>) => {
        iframe?.contentWindow?.postMessage(response, "*");
      };

      if (!FETCH_PROXY_ALLOWED_PATH_RE.test(path)) {
        sendResponse({
          type: "vellum_fetch_response",
          callId,
          error: "Request blocked: only /v1/x/ custom routes are allowed",
        });
        return;
      }

      try {
        const canonical = new URL(path, "https://placeholder").pathname;
        if (!FETCH_PROXY_ALLOWED_PATH_RE.test(canonical)) {
          sendResponse({
            type: "vellum_fetch_response",
            callId,
            error: "Request blocked: path traversal detected",
          });
          return;
        }
      } catch {
        sendResponse({
          type: "vellum_fetch_response",
          callId,
          error: "Request blocked: invalid path",
        });
        return;
      }

      const proxyUrl = `/v1/assistants/${assistantId}/${path.replace(/^\/v1\//, "")}`;
      try {
        const fetchOptions = {
          url: proxyUrl,
          throwOnError: false as const,
          headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
          body: body ? JSON.parse(body) : undefined,
        };

        const clientMethod =
          method === "POST"
            ? client.post
            : method === "PUT"
              ? client.put
              : method === "PATCH"
                ? client.patch
                : method === "DELETE"
                  ? client.delete
                  : client.get;
        const response = await clientMethod(fetchOptions);

        const httpResponse = response.response;
        const responseBody = response.data ?? response.error;
        const bodyStr =
          responseBody == null
            ? ""
            : typeof responseBody === "string"
              ? responseBody
              : JSON.stringify(responseBody);

        sendResponse({
          type: "vellum_fetch_response",
          callId,
          status: httpResponse?.status ?? 0,
          statusText: httpResponse?.statusText ?? "",
          body: bodyStr,
        });
      } catch (err) {
        sendResponse({
          type: "vellum_fetch_response",
          callId,
          error: err instanceof Error ? err.message : "Fetch proxy error",
        });
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [appId, assistantId]);

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

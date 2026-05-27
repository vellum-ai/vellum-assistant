import { Minimize2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { client } from "@/generated/api/client.gen";
import { AppCard } from "@/domains/chat/components/app-card";
import { clearAppHtmlCache, getCachedAppHtml } from "@/domains/chat/api/apps";
import { usePinnedAppsStore } from "@/domains/chat/pinned-apps-store";
import type { Surface } from "@/domains/chat/types/types";
import { getDynamicPageAppId } from "@/domains/chat/components/surfaces/dynamic-page-app-id";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DynamicPagePreview {
  title: string;
  subtitle?: string;
  description?: string;
  icon?: string;
  context?: string;
}

interface DynamicPageSurfaceData {
  html: string;
  width?: number;
  height?: number;
  appId?: string;
  app_id?: string;
  appType?: string;
  status?: string;
  preview?: DynamicPagePreview;
}

interface DynamicPageSurfaceProps {
  surface: Surface;
  onAction: (surfaceId: string, actionId: string, data?: Record<string, unknown>) => void;
  assistantId?: string | null;
  onOpenApp?: (appId: string) => void;
  isToolCallComplete?: boolean;
}

// ---------------------------------------------------------------------------
// Fetch proxy path validation (matches desktop ATL-83 restriction)
// ---------------------------------------------------------------------------

const FETCH_PROXY_ALLOWED_PATH_RE = /^\/v1\/x\//;

// ---------------------------------------------------------------------------
// JS bridge script
// ---------------------------------------------------------------------------

function buildBridgeScript(surfaceId: string, enableFetch: boolean): string {
  const fetchBridge = enableFetch
    ? `
  window.vellum._pendingFetches = {};
  window.vellum._fetchNextId = 1;
  window.vellum._resolveFetch = function(callId, status, statusText, body, headers) {
    var p = window.vellum._pendingFetches[callId];
    if (!p) return;
    delete window.vellum._pendingFetches[callId];
    p.resolve({
      ok: status >= 200 && status < 300,
      status: status,
      statusText: statusText,
      headers: headers || {},
      _body: body,
      json: function() { return Promise.resolve(JSON.parse(body)); },
      text: function() { return Promise.resolve(body); }
    });
  };
  window.vellum._rejectFetch = function(callId, errorMessage) {
    var p = window.vellum._pendingFetches[callId];
    if (!p) return;
    delete window.vellum._pendingFetches[callId];
    p.reject(new Error(errorMessage));
  };
  window.addEventListener('message', function(event) {
    var d = event.data;
    if (!d) return;
    if (d.type === 'vellum_fetch_response' && d.callId) {
      if (d.error) {
        window.vellum._rejectFetch(d.callId, d.error);
      } else {
        window.vellum._resolveFetch(d.callId, d.status, d.statusText, d.body, d.headers);
      }
    }
  });
  window.vellum.fetch = function(path, options) {
    options = options || {};
    return new Promise(function(resolve, reject) {
      var callId = 'f' + (window.vellum._fetchNextId++);
      window.vellum._pendingFetches[callId] = { resolve: resolve, reject: reject };
      window.parent.postMessage({
        type: 'vellum_fetch_request',
        surfaceId: ${JSON.stringify(surfaceId)},
        callId: callId,
        path: path,
        method: (options.method || 'GET').toUpperCase(),
        headers: options.headers || {},
        body: options.body || null
      }, '*');
    });
  };`
    : "";

  return `<script>
(function() {
  var store = {};
  var storageShim = {
    getItem: function(k) { return store.hasOwnProperty(k) ? store[k] : null; },
    setItem: function(k, v) { store[k] = String(v); },
    removeItem: function(k) { delete store[k]; },
    clear: function() { store = {}; },
    get length() { return Object.keys(store).length; },
    key: function(i) { return Object.keys(store)[i] || null; }
  };
  try {
    Object.defineProperty(window, 'localStorage', { value: storageShim, writable: true, configurable: true });
  } catch(e) {
    window.localStorage = storageShim;
  }
  try {
    Object.defineProperty(window, 'sessionStorage', { value: storageShim, writable: true, configurable: true });
  } catch(e) {
    window.sessionStorage = storageShim;
  }

  window.vellum = {
    sendAction: function(actionId, data) {
      window.parent.postMessage({
        type: 'vellum_surface_action',
        surfaceId: ${JSON.stringify(surfaceId)},
        actionId: actionId,
        data: data || {}
      }, '*');
    }
  };${fetchBridge}
})();
</script>`;
}

// ---------------------------------------------------------------------------
// Inject bridge into HTML
// ---------------------------------------------------------------------------

function injectBridge(html: string, surfaceId: string, enableFetch: boolean): string {
  const bridge = buildBridgeScript(surfaceId, enableFetch);
  if (html.includes("</body>")) {
    return html.replace("</body>", bridge + "</body>");
  }
  if (html.includes("</head>")) {
    return html.replace("</head>", "</head>" + bridge);
  }
  return bridge + html;
}

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------

function StatusPill({ text }: { text: string }) {
  const [state, setState] = useState({ trackedText: text, hidden: false });

  if (state.trackedText !== text) {
    setState({ trackedText: text, hidden: false });
  }

  useEffect(() => {
    const timer = setTimeout(() => setState((s) => ({ ...s, hidden: true })), 3000);
    return () => clearTimeout(timer);
  }, [text]);

  if (state.hidden) return null;

  return (
    <div className="absolute top-2 right-2 z-10 rounded-full bg-[var(--primary-base)]/80 px-3 py-1 text-body-small-default text-[var(--content-inset)] shadow-sm backdrop-blur-sm transition-opacity duration-300">
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DynamicPageSurface({
  surface,
  onAction,
  assistantId,
  onOpenApp,
  isToolCallComplete = true,
}: DynamicPageSurfaceProps) {
  const pinnedAppIds = usePinnedAppsStore.use.pinnedAppIds();
  const togglePin = usePinnedAppsStore.use.togglePin();
  const data = surface.data as unknown as DynamicPageSurfaceData;
  const appId = getDynamicPageAppId(surface);
  const inlineHtml = typeof data.html === "string" && data.html.length > 0
    ? data.html
    : null;
  const [expanded, setExpanded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const enableFetch = Boolean(appId && assistantId);

  const iframeKey = useMemo(() => {
    let hash = 0;
    const str = data.html || "";
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return `iframe-${surface.surfaceId}-${hash}`;
  }, [data.html, surface.surfaceId]);

  const srcdoc = useMemo(
    () => injectBridge(data.html || "", surface.surfaceId, enableFetch),
    [data.html, surface.surfaceId, enableFetch],
  );

  useEffect(() => {
    if (!isToolCallComplete && assistantId && appId) {
      clearAppHtmlCache(assistantId, appId);
    }
  }, [assistantId, appId, isToolCallComplete]);

  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || msg.surfaceId !== surface.surfaceId) return;
      if (event.source !== iframeRef.current?.contentWindow) return;

      if (msg.type === "vellum_surface_action") {
        onAction(surface.surfaceId, msg.actionId, msg.data);
        return;
      }

      if (msg.type === "vellum_fetch_request" && enableFetch && assistantId) {
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
        return;
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [surface.surfaceId, onAction, enableFetch, assistantId]);

  const handleCollapse = useCallback(() => setExpanded(false), []);
  const handleOpenPreview = useCallback(() => {
    if (appId && onOpenApp) {
      onOpenApp(appId);
      return;
    }
    if (inlineHtml != null) {
      setExpanded(true);
    }
  }, [appId, inlineHtml, onOpenApp]);

  const onOpenPreview = appId && onOpenApp
    ? handleOpenPreview
    : inlineHtml != null
      ? handleOpenPreview
      : undefined;

  // Memoize the live-preview loader so AppPreviewThumbnail's effect doesn't
  // tear down + re-attach its IntersectionObserver on every parent render.
  const loadHtmlForPreview = useMemo(
    () =>
      isToolCallComplete
        ? assistantId && appId
          ? () => getCachedAppHtml(assistantId, appId)
          : inlineHtml != null
            ? () => Promise.resolve(inlineHtml)
            : undefined
        : undefined,
    [assistantId, appId, inlineHtml, isToolCallComplete],
  );

  // Always show AppCard for dynamic_page surfaces with preview data
  if (data.preview && !expanded) {
    const cardName = data.preview.title || surface.title || "App";
    const isPinned = appId ? pinnedAppIds.has(appId) : false;
    const onPin = appId
      ? () =>
          togglePin({
            id: appId,
            name: cardName,
            icon: data.preview?.icon,
            createdAt: 0,
            version: "",
            contentId: "",
          })
      : undefined;
    return (
      <div className="max-w-sm">
        <AppCard
          name={cardName}
          description={data.preview.description}
          icon={data.preview.icon}
          loadHtml={loadHtmlForPreview}
          isPinned={isPinned}
          isOpenDisabled={!isToolCallComplete}
          isPreviewPending={!isToolCallComplete}
          onOpen={isToolCallComplete ? onOpenPreview : undefined}
          onPin={onPin}
        />
      </div>
    );
  }

  const width = data.width ? `${data.width}px` : "100%";
  const height = data.height ? `${data.height}px` : "400px";

  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)]">
      {(surface.title || expanded) && (
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-2">
          <span className="text-title-small text-[var(--content-strong)]">
            {surface.title}
          </span>
          {expanded && (
            <button
              type="button"
              onClick={handleCollapse}
              className="flex items-center gap-1 rounded p-1 text-body-small-default text-[var(--content-quiet)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)]"
            >
              <Minimize2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      <div className="relative">
        {data.status && <StatusPill text={data.status} />}
        <iframe
          ref={iframeRef}
          key={iframeKey}
          srcDoc={srcdoc}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          title={surface.title || "Dynamic content"}
          style={{
            width,
            height,
            minHeight: "200px",
            maxHeight: "80vh",
            border: "none",
            display: "block",
            overflow: "auto",
          }}
          className="w-full rounded-b-lg"
        />
      </div>
    </div>
  );
}

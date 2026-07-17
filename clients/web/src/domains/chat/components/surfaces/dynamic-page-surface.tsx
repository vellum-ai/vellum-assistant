import { Minimize2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AppCard } from "@/components/app-card";
import { clearAppHtmlCache, getCachedAppHtml } from "@/utils/app-html-cache";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import { useSandboxFetchProxy } from "@/hooks/use-sandbox-fetch-proxy";
import { injectBridge } from "@/utils/sandbox-bridge";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { isSurfaceToolCallComplete, type Surface } from "@/domains/chat/types/types";
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
  /** Tool calls of the message this surface belongs to. The preview unlocks
   *  once the surface's originating tool call has completed. */
  toolCalls?: ChatMessageToolCall[];
  /** Handler for `vellum://` file links clicked inside the sandboxed iframe.
   *  The sandbox can't navigate or `window.open()` these, so the click is
   *  forwarded here to resolve the linked attachment and download it — the
   *  same behavior as chat's `onVellumLinkClick`. */
  onVellumLinkClick?: (href: string, linkText: string) => void;
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

  if (state.hidden) {
    return null;
  }

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
  toolCalls,
  onVellumLinkClick,
}: DynamicPageSurfaceProps) {
  const pinnedAppIds = usePinnedAppsStore.use.pinnedAppIds();
  const togglePin = usePinnedAppsStore.use.togglePin();
  const data = surface.data as unknown as DynamicPageSurfaceData;
  const appId = getDynamicPageAppId(surface);
  const isToolCallComplete = useMemo(
    () => isSurfaceToolCallComplete(surface, toolCalls),
    [surface, toolCalls],
  );
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
    () => injectBridge(data.html || "", surface.surfaceId, { fetch: enableFetch }),
    [data.html, surface.surfaceId, enableFetch],
  );

  useEffect(() => {
    if (!isToolCallComplete && assistantId && appId) {
      clearAppHtmlCache(assistantId, appId);
    }
  }, [assistantId, appId, isToolCallComplete]);

  const handleSurfaceAction = useCallback(
    (actionId: string, data?: Record<string, unknown>) => {
      onAction(surface.surfaceId, actionId, data);
    },
    [surface.surfaceId, onAction],
  );

  useSandboxFetchProxy(iframeRef, {
    frameId: surface.surfaceId,
    assistantId: assistantId ?? "",
    enabled: enableFetch,
    onAction: handleSurfaceAction,
    onOpenVellumLink: onVellumLinkClick,
  });

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

  if (data.preview && !expanded) {
    const cardName = data.preview.title || surface.title || "App";
    const isPinned = appId ? pinnedAppIds.has(appId) : false;
    const onPin = appId
      ? () =>
          togglePin({
            id: appId,
            name: cardName,
            icon: data.preview?.icon,
          })
      : undefined;
    return (
      // `max-md:mt-2` adds breathing room between the activity status line
      // and the app card on mobile; stacks on the transcript column's `gap-2`
      // for 16px total.
      <div className="max-w-sm max-md:mt-2">
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

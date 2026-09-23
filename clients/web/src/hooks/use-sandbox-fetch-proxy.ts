/**
 * Parent-side postMessage handler for sandboxed app iframes.
 *
 * Listens for `vellum_surface_action` and `vellum_fetch_request` messages
 * from a sandboxed iframe and either forwards them to the provided callback
 * or proxies fetch requests through the parent's authenticated API client.
 *
 * It also answers `vellum_context_request` with the host's current
 * conversation selection. That is a read of host state rather than a proxy
 * of an app request, and it is deliberately the only such read: the reply
 * carries the two conversation ids and nothing else, so the bridge stays a
 * narrow context API rather than general access to the host's stores.
 *
 * Messages are routed by checking both `event.source` (must match the
 * iframe's `contentWindow`) and the `frameId` payload field (must match
 * the ID embedded in the bridge script). This provides defense-in-depth
 * when multiple sandboxed iframes coexist on the same page.
 *
 * @see {@link @/utils/sandbox-bridge} for the in-iframe bridge that sends these messages
 */

import { type RefObject, useEffect, useRef } from "react";
import { useLocation } from "react-router";

import { client } from "@/generated/api/client.gen";
import { subscribe as busSubscribe } from "@/lib/event-bus";
import { useConversationStore } from "@/stores/conversation-store";
import { isConversationPath } from "@/utils/routes";
import {
  FETCH_PROXY_PATH_RE,
  getRelayableAppRoute,
} from "@/utils/sandbox-bridge";
import { forwardableSyncTags } from "@/utils/sandbox-sync-filter";

export interface SandboxFetchProxyOptions {
  /** Unique identifier matching the bridge's `frameId`. */
  frameId: string;
  /** Assistant ID for constructing proxy URLs. */
  assistantId: string;
  /**
   * The app whose bundled assets `window.vellum.asset()` may read. Scopes
   * asset requests to this app so a sandboxed frame can only reach its own
   * files. Omit for non-app sandboxes — asset requests then fail gracefully.
   */
  appId?: string;
  /** Whether the fetch proxy is active. Surface actions are always forwarded regardless. Default: true. */
  enabled?: boolean;
  /** Handler for surface action messages from the sandboxed app. */
  onAction?: (actionId: string, data?: Record<string, unknown>) => void;
  /**
   * Handler for `vellum://` file link clicks forwarded from the sandboxed app.
   * Always invoked regardless of the `enabled` flag (like surface actions),
   * since the parent — not the sandbox — must resolve and download the file.
   */
  onOpenVellumLink?: (href: string, linkText: string) => void;
  /** Handler for validated root-relative Vellum app routes. */
  onNavigateAppRoute?: (href: string) => void;
}

/**
 * Listen for postMessage events from a sandboxed iframe and proxy
 * authenticated fetch requests through the parent's API client.
 *
 * The message listener is always active so surface action messages
 * reach `onAction` regardless of the `enabled` flag. Only fetch
 * proxy requests are gated by `enabled`.
 */
export function useSandboxFetchProxy(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  options: SandboxFetchProxyOptions,
): void {
  const {
    frameId,
    assistantId,
    appId,
    enabled = true,
    onAction,
    onOpenVellumLink,
    onNavigateAppRoute,
  } = options;

  // subId → the sync tags the sandboxed app asked to hear about. Held in a ref,
  // not effect-local state, so it survives effect restarts: a dependency change
  // (e.g. assistantId resolving, or a new callback identity) re-runs the effect
  // while the iframe stays mounted and never re-sends vellum_subscribe — a local
  // map would be wiped and later matching events silently dropped. The ref is
  // discarded with the component on unmount.
  const subscriptionsRef = useRef<Map<string, Set<string>>>(new Map());

  // The route the host is on, held in a ref for the same reason the store is
  // read at request time: a context request is answered from wherever the
  // host is when it is asked, and keeping the pathname out of the effect's
  // dependencies means navigating never re-registers the listener.
  const { pathname } = useLocation();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  useEffect(() => {
    const subscriptions = subscriptionsRef.current;

    const handler = async (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || msg.frameId !== frameId) {
        return;
      }
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }

      if (msg.type === "vellum_subscribe") {
        if (!enabled) {
          return;
        }
        const { subId, tags } = msg as { subId: string; tags: unknown };
        if (typeof subId === "string" && Array.isArray(tags)) {
          subscriptions.set(
            subId,
            new Set(tags.filter((t): t is string => typeof t === "string")),
          );
        }
        return;
      }

      if (msg.type === "vellum_unsubscribe") {
        const { subId } = msg as { subId: string };
        if (typeof subId === "string") {
          subscriptions.delete(subId);
        }
        return;
      }

      if (msg.type === "vellum_surface_action") {
        onAction?.(msg.actionId, msg.data);
        return;
      }

      if (msg.type === "vellum_navigate") {
        if (!navigator.userActivation?.isActive) {
          return;
        }
        const href = getRelayableAppRoute(msg.href);
        if (href) {
          onNavigateAppRoute?.(href);
        }
        return;
      }

      if (msg.type === "vellum_open_link") {
        // Guard against untrusted iframe abuse: the sandboxed component
        // can read its embedded frameId and send vellum_open_link without
        // a user click. Only honor the message when there is an active
        // user activation (transient — typically ~5s after a user
        // gesture), so programmatic spam on load or in a loop can't
        // trigger unsolicited downloads.
        if (!navigator.userActivation?.isActive) {
          return;
        }
        onOpenVellumLink?.(msg.href, msg.linkText);
        return;
      }

      if (msg.type === "vellum_context_request") {
        const { callId } = msg as { callId: string };
        const sendContext = (response: Record<string, unknown>) => {
          iframeRef.current?.contentWindow?.postMessage(response, "*");
        };
        if (!enabled) {
          sendContext({
            type: "vellum_context_response",
            callId,
            error: "Context bridge disabled",
          });
          return;
        }
        // Read at request time, never at mount: the host's selection moves
        // while the app stays mounted (a split-view conversation switch), so
        // a value captured when the effect ran would be stale from then on.
        // `getState()` is the store's documented read outside the React
        // render cycle, and reading it here rather than through a prop keeps
        // the selection out of this effect's dependencies, so a switch never
        // tears down and re-registers the listener.
        const { activeConversationId, editingConversationId } =
          useConversationStore.getState();
        // Both ids are selection, not visibility: `activeConversationId`
        // deliberately survives leaving the conversation area (see
        // `chat-layout.tsx`), and the split-view binding is cleared by the
        // paths that dismantle the split rather than by leaving. A Library app
        // opened after a chat would otherwise be handed the conversation the
        // user walked away from, which is the most-recently-used guess this
        // API's contract says it is not.
        //
        // The route is what says whether either one is on screen: the split
        // view and the conversation pane both live under the conversation
        // routes, so off them neither id describes anything the user can see.
        // Gating both here keeps that one rule in one place instead of
        // depending on every navigation path remembering to clear.
        const conversationVisible = isConversationPath(pathnameRef.current);
        sendContext({
          type: "vellum_context_response",
          callId,
          activeConversationId: conversationVisible
            ? (activeConversationId ?? null)
            : null,
          editingConversationId: conversationVisible
            ? (editingConversationId ?? null)
            : null,
        });
        return;
      }

      if (msg.type === "vellum_asset_request") {
        const { callId, path } = msg as { callId: string; path: string };
        const iframe = iframeRef.current;
        const sendAsset = (
          response: Record<string, unknown>,
          transfer?: Transferable[],
        ) => {
          iframe?.contentWindow?.postMessage(response, "*", transfer ?? []);
        };
        if (!enabled) {
          sendAsset({
            type: "vellum_asset_response",
            callId,
            error: "Asset proxy disabled",
          });
          return;
        }
        if (!appId) {
          sendAsset({
            type: "vellum_asset_response",
            callId,
            error: "No app context for assets",
          });
          return;
        }
        if (typeof path !== "string" || path === "" || path.includes("..")) {
          sendAsset({
            type: "vellum_asset_response",
            callId,
            error: "Invalid asset path",
          });
          return;
        }
        try {
          const encodedPath = path.split("/").map(encodeURIComponent).join("/");
          const url = `/v1/assistants/${assistantId}/apps/${appId}/asset/${encodedPath}`;
          const { data: blob, response } = await client.get({
            url,
            parseAs: "blob",
            throwOnError: false,
          });
          if (!response?.ok || !(blob instanceof Blob)) {
            sendAsset({
              type: "vellum_asset_response",
              callId,
              error: `Asset fetch failed (${response?.status ?? 0})`,
            });
            return;
          }
          const buffer = await blob.arrayBuffer();
          sendAsset(
            {
              type: "vellum_asset_response",
              callId,
              buffer,
              contentType: blob.type || "application/octet-stream",
            },
            [buffer],
          );
        } catch (err) {
          sendAsset({
            type: "vellum_asset_response",
            callId,
            error: err instanceof Error ? err.message : "Asset proxy error",
          });
        }
        return;
      }

      if (!enabled || msg.type !== "vellum_fetch_request") {
        return;
      }

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

      if (!FETCH_PROXY_PATH_RE.test(path)) {
        sendResponse({
          type: "vellum_fetch_response",
          callId,
          error: "Request blocked: only /v1/x/ custom routes are allowed",
        });
        return;
      }

      try {
        const canonical = new URL(path, "https://placeholder").pathname;
        if (!FETCH_PROXY_PATH_RE.test(canonical)) {
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
          headers:
            headers && Object.keys(headers).length > 0 ? headers : undefined,
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

    // Forward host `sync_changed` invalidations to any sandbox subscription
    // whose tags match, scoped by `forwardableSyncTags` (reserved host
    // namespaces are never delivered). Only `sync_changed` is forwarded — no
    // event carrying a payload crosses into the sandbox.
    const busUnsubscribe = busSubscribe("sse.event", (envelope) => {
      const message = envelope.message as
        { type?: string; tags?: unknown } | undefined;
      if (
        !message ||
        message.type !== "sync_changed" ||
        !Array.isArray(message.tags)
      ) {
        return;
      }
      const contentWindow = iframeRef.current?.contentWindow;
      if (!contentWindow || subscriptions.size === 0) {
        return;
      }
      const eventTags = message.tags.filter(
        (t): t is string => typeof t === "string",
      );
      for (const [subId, wanted] of subscriptions) {
        const tags = forwardableSyncTags([...wanted], eventTags);
        if (tags.length > 0) {
          contentWindow.postMessage(
            {
              type: "vellum_event",
              frameId,
              subId,
              event: { type: "sync_changed", tags },
            },
            "*",
          );
        }
      }
    });

    return () => {
      window.removeEventListener("message", handler);
      busUnsubscribe();
      // Deliberately not clearing `subscriptions`: it must survive effect
      // re-runs so subscriptions registered before a dependency change keep
      // receiving events. It is discarded with the component on unmount.
    };
  }, [
    frameId,
    assistantId,
    appId,
    enabled,
    onAction,
    onOpenVellumLink,
    onNavigateAppRoute,
    iframeRef,
  ]);
}

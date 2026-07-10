/**
 * Parent-side postMessage handler for sandboxed app iframes.
 *
 * Listens for `vellum_surface_action` and `vellum_fetch_request` messages
 * from a sandboxed iframe and either forwards them to the provided callback
 * or proxies fetch requests through the parent's authenticated API client.
 *
 * Messages are routed by checking both `event.source` (must match the
 * iframe's `contentWindow`) and the `frameId` payload field (must match
 * the ID embedded in the bridge script). This provides defense-in-depth
 * when multiple sandboxed iframes coexist on the same page.
 *
 * @see {@link @/utils/sandbox-bridge} for the in-iframe bridge that sends these messages
 */

import { type RefObject, useEffect } from "react";

import { client } from "@/generated/api/client.gen";
import { FETCH_PROXY_PATH_RE } from "@/utils/sandbox-bridge";

export interface SandboxFetchProxyOptions {
  /** Unique identifier matching the bridge's `frameId`. */
  frameId: string;
  /** Assistant ID for constructing proxy URLs. */
  assistantId: string;
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
  const { frameId, assistantId, enabled = true, onAction, onOpenVellumLink } =
    options;

  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || msg.frameId !== frameId) return;
      if (event.source !== iframeRef.current?.contentWindow) return;

      if (msg.type === "vellum_surface_action") {
        onAction?.(msg.actionId, msg.data);
        return;
      }

      if (msg.type === "vellum_open_link") {
        // Guard against untrusted iframe abuse: the sandboxed component
        // can read its embedded frameId and send vellum_open_link without
        // a user click. Only honor the message when there is an active
        // user activation (transient — typically ~5s after a user
        // gesture), so programmatic spam on load or in a loop can't
        // trigger unsolicited downloads.
        if (!navigator.userActivation?.isActive) return;
        onOpenVellumLink?.(msg.href, msg.linkText);
        return;
      }

      if (!enabled || msg.type !== "vellum_fetch_request") return;

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
  }, [frameId, assistantId, enabled, onAction, onOpenVellumLink, iframeRef]);
}

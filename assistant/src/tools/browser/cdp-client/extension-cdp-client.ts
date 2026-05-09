import type { HostBrowserProxy } from "../../../daemon/host-browser-proxy.js";
import { getLogger } from "../../../util/logger.js";
import type { CdpErrorCode } from "./errors.js";
import { CdpError } from "./errors.js";
import type { CdpClientKind, ScopedCdpClient } from "./types.js";

const log = getLogger("extension-cdp-client");

/**
 * Transport-level error codes that the host_browser dispatcher may
 * embed in a structured `{ code, message }` error envelope. When the
 * `code` field of a parsed error object matches one of these values,
 * the error is classified as `transport_error` so the factory's
 * failover logic can try the next backend candidate.
 *
 * Codes that are NOT in this set are treated as CDP command-level
 * failures (`cdp_error`) and propagate without failover.
 */
const TRANSPORT_ERROR_CODES = new Set([
  "transport_error",
  "unreachable",
  "timeout",
  "non_loopback",
  "cdp_session_not_found",
  "cancelled",
]);

/**
 * CdpClient backed by HostBrowserProxy. Each `send` becomes a
 * host_browser_request / host_browser_result round-trip over the
 * chrome-extension WebSocket.
 *
 * Unlike LocalCdpClient, this implementation cannot deliver
 * CDP events (subscribing to "Page.lifecycleEvent" etc.) because
 * HostBrowserProxy is request/reply only. Helpers that need
 * event subscription (waitForLifecycleEvent) must fall back to
 * polling via Runtime.evaluate — see cdp-dom-helpers.ts#navigateAndWait.
 */
export class ExtensionCdpClient implements ScopedCdpClient {
  readonly kind: CdpClientKind = "extension";
  private disposed = false;

  constructor(
    private readonly proxy: HostBrowserProxy,
    public readonly conversationId: string,
    private readonly cdpSessionId?: string,
    /**
     * Caller's actor principal id. When provided, the proxy will refuse to
     * dispatch this CDP command to a host_browser-capable client owned by a
     * different actor — closing the cross-client exposure path's same-user
     * boundary.
     */
    private readonly sourceActorPrincipalId?: string,
    /**
     * Explicit target client id. When provided, the proxy routes directly to
     * that client instead of applying the interface-preference order.
     */
    private readonly targetClientId?: string,
  ) {}

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.disposed) {
      throw new CdpError("disposed", "ExtensionCdpClient already disposed", {
        cdpMethod: method,
        cdpParams: params,
      });
    }
    if (signal?.aborted) {
      throw new CdpError("aborted", "Aborted before send", {
        cdpMethod: method,
        cdpParams: params,
      });
    }

    let result;
    try {
      result = await this.proxy.request(
        {
          cdpMethod: method,
          cdpParams: params,
          cdpSessionId: this.cdpSessionId,
        },
        this.conversationId,
        signal,
        this.sourceActorPrincipalId,
        this.targetClientId,
      );
    } catch (err) {
      throw new CdpError(
        "transport_error",
        err instanceof Error ? err.message : String(err),
        {
          cdpMethod: method,
          cdpParams: params,
          underlying: err,
        },
      );
    }

    if (signal?.aborted || result.content === "Aborted") {
      throw new CdpError("aborted", "CDP call aborted", {
        cdpMethod: method,
        cdpParams: params,
      });
    }

    if (result.isError) {
      let parsedError: unknown;
      try {
        parsedError = JSON.parse(result.content);
      } catch {
        // The host-browser dispatcher may surface plain-text errors
        // (for example timeout/callback-delivery failures) instead
        // of JSON-RPC envelopes. Treat these as CDP-level failures so
        // the factory does not silently fail over to cdp-inspect/local
        // and mask the extension path as the true failing hop.
        throw new CdpError(
          "cdp_error",
          result.content.slice(0, 200) || `CDP error for ${method}`,
          {
            cdpMethod: method,
            cdpParams: params,
            underlying: result.content,
          },
        );
      }

      const msg =
        (typeof parsedError === "object" &&
          parsedError !== null &&
          "message" in parsedError &&
          typeof (parsedError as { message: unknown }).message === "string" &&
          (parsedError as { message: string }).message) ||
        `CDP error for ${method}`;

      // Detect structured transport error envelopes from the
      // host_browser dispatcher. When the parsed error object
      // carries a `code` field that matches a known transport-level
      // code, classify the error as `transport_error` so the
      // factory can trigger failover to the next backend candidate.
      // All other structured errors remain `cdp_error` since they
      // represent command-level CDP failures that would not benefit
      // from switching transports.
      const errorCode = classifyHostBrowserError(parsedError);
      log.debug(
        { method, params, parsedError, classifiedAs: errorCode },
        "ExtensionCdpClient: host_browser_result error",
      );
      throw new CdpError(errorCode, msg, {
        cdpMethod: method,
        cdpParams: params,
        underlying: parsedError,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.content);
    } catch (err) {
      throw new CdpError(
        "transport_error",
        `Non-JSON content from host_browser_result: ${result.content.slice(0, 200)}`,
        {
          cdpMethod: method,
          cdpParams: params,
          underlying: err,
        },
      );
    }

    return parsed as T;
  }

  dispose(): void {
    this.disposed = true;
    // HostBrowserProxy is owned by the conversation — do NOT dispose
    // it here. In-flight requests will be cancelled by the AbortSignal
    // the tool passes in, or by conversation teardown.
  }
}

/**
 * Classify a parsed host_browser_result error envelope as either a
 * transport-level error (`transport_error`) or a command-level CDP
 * failure (`cdp_error`).
 *
 * Structured envelopes from the host_browser dispatcher carry a
 * `code` string field (e.g. `"transport_error"`, `"unreachable"`,
 * `"timeout"`, `"non_loopback"`, `"cdp_session_not_found"`,
 * `"cancelled"`). When the code matches a known
 * transport-level value, the error is eligible for factory failover.
 * All other codes (or missing codes) are treated as CDP command
 * errors that should propagate without failover.
 */
function classifyHostBrowserError(parsed: unknown): CdpErrorCode {
  if (typeof parsed !== "object" || parsed === null) return "cdp_error";
  if (!("code" in parsed)) return "cdp_error";
  const code = (parsed as { code: unknown }).code;
  if (typeof code !== "string") return "cdp_error";
  return TRANSPORT_ERROR_CODES.has(code) ? "transport_error" : "cdp_error";
}

export function createExtensionCdpClient(
  proxy: HostBrowserProxy,
  conversationId: string,
  cdpSessionId?: string,
  sourceActorPrincipalId?: string,
  targetClientId?: string,
): ExtensionCdpClient {
  return new ExtensionCdpClient(
    proxy,
    conversationId,
    cdpSessionId,
    sourceActorPrincipalId,
    targetClientId,
  );
}

import type { HostBrowserProxy } from "../../../daemon/host-browser-proxy.js";
import { getLogger } from "../../../util/logger.js";
import { CdpError } from "./errors.js";
import type { CdpClientKind, ScopedCdpClient } from "./types.js";

const log = getLogger("extension-cdp-client");

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

    if (result.isError) {
      const msg =
        (typeof parsed === "object" &&
          parsed !== null &&
          "message" in parsed &&
          typeof (parsed as { message: unknown }).message === "string" &&
          (parsed as { message: string }).message) ||
        `CDP error for ${method}`;
      log.debug({ method, params, parsed }, "ExtensionCdpClient: CDP error");
      throw new CdpError("cdp_error", msg, {
        cdpMethod: method,
        cdpParams: params,
        underlying: parsed,
      });
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

export function createExtensionCdpClient(
  proxy: HostBrowserProxy,
  conversationId: string,
  cdpSessionId?: string,
): ExtensionCdpClient {
  return new ExtensionCdpClient(proxy, conversationId, cdpSessionId);
}

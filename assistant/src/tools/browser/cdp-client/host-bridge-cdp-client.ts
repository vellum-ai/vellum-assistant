import type { HostBrowserProxy } from "../../../daemon/host-browser-proxy.js";
import { CdpError } from "./errors.js";
import { ExtensionCdpClient } from "./extension-cdp-client.js";
import type { CdpClientKind } from "./types.js";

/**
 * CdpClient for the desktop host-browser bridge: raw CDP commands are
 * routed through HostBrowserProxy to the desktop client's SSE bridge,
 * which executes them against the user's Chrome via its local
 * remote-debugging port. Reuses ExtensionCdpClient's request/reply and
 * error-classification plumbing with three deliberate differences:
 *
 *  - `kind` is `"host-bridge"`, so transport-aware tool branches
 *    (e.g. `--new-tab`'s `Vellum.createTab` path) correctly treat the
 *    bridge as a non-extension backend.
 *  - No pinned-tab `cdpSessionId` is ever injected: extension pins
 *    store Chrome tab ids, which never match the CDP target ids the
 *    bridge resolves from `/json/list` and would guarantee
 *    `cdp_session_not_found` failures.
 *  - Tab methods throw locally instead of sending `Vellum.*`
 *    pseudo-methods the bridge cannot serve (matches the
 *    local/cdp-inspect client convention).
 */
export class HostBridgeCdpClient extends ExtensionCdpClient {
  override readonly kind: CdpClientKind = "host-bridge";

  constructor(
    proxy: HostBrowserProxy,
    conversationId: string,
    sourceActorPrincipalId?: string,
  ) {
    super(
      proxy,
      conversationId,
      /* cdpSessionId */ undefined,
      sourceActorPrincipalId,
      /* targetClientId */ undefined,
    );
  }

  override async listTabs(): Promise<never> {
    throw unsupportedTabOperation("listTabs");
  }

  override async selectTab(_tabId: number): Promise<never> {
    throw unsupportedTabOperation("selectTab");
  }

  override async closeTab(_tabId: number): Promise<never> {
    throw unsupportedTabOperation("closeTab");
  }
}

function unsupportedTabOperation(operation: string): CdpError {
  return new CdpError(
    "transport_error",
    `${operation} is not supported by the host-bridge backend (extension backend required)`,
  );
}

export function createHostBridgeCdpClient(
  proxy: HostBrowserProxy,
  conversationId: string,
  sourceActorPrincipalId?: string,
): HostBridgeCdpClient {
  return new HostBridgeCdpClient(proxy, conversationId, sourceActorPrincipalId);
}

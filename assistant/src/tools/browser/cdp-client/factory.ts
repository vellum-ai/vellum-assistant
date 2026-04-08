import type { ToolContext } from "../../types.js";
import { createExtensionCdpClient } from "./extension-cdp-client.js";
import { createLocalCdpClient } from "./local-cdp-client.js";
import type { ScopedCdpClient } from "./types.js";

/**
 * Select the appropriate CdpClient implementation for a tool
 * invocation based on the ToolContext:
 *
 *  - When `context.hostBrowserProxy` is set (macOS desktop / cloud-
 *    hosted with a chrome-extension bound to the conversation),
 *    return an ExtensionCdpClient so CDP commands ride the
 *    host_browser_request / host_browser_result round-trip.
 *  - Otherwise (CLI, tests, headless Chromium launched in-process),
 *    return a LocalCdpClient that drives Playwright's CDPSession
 *    against the sacrificial-profile browser managed by
 *    browserManager.
 *
 * The returned client is `kind`-tagged so tools can branch on
 * transport — e.g. browser_navigate skips the Playwright-specific
 * screencast and handoff hooks when `kind === "extension"`.
 *
 * IMPORTANT: the returned client is per-invocation. Tools MUST call
 * `dispose()` in a finally block to release the CDP session (local
 * path) or mark the wrapper disposed (extension path). Disposing
 * an ExtensionCdpClient does NOT dispose the underlying
 * HostBrowserProxy — that is owned by the conversation.
 */
export function getCdpClient(context: ToolContext): ScopedCdpClient {
  if (context.hostBrowserProxy) {
    return createExtensionCdpClient(
      context.hostBrowserProxy,
      context.conversationId,
    );
  }
  return createLocalCdpClient(context.conversationId);
}

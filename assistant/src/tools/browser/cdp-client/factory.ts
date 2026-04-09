import {
  type BrowserBackend,
  BrowserSessionManager,
  type CdpCommand,
  type CdpResult,
  createExtensionBackend,
  createLocalBackend,
} from "../../../browser-session/index.js";
import type { ToolContext } from "../../types.js";
import { CdpError } from "./errors.js";
import { createExtensionCdpClient } from "./extension-cdp-client.js";
import { createLocalCdpClient } from "./local-cdp-client.js";
import type { CdpClient, CdpClientKind, ScopedCdpClient } from "./types.js";

/**
 * Select the appropriate CdpClient implementation for a tool
 * invocation based on the ToolContext:
 *
 *  - When `context.hostBrowserProxy` is set (macOS desktop / cloud-
 *    hosted with a chrome-extension bound to the conversation),
 *    register an extension backend so CDP commands ride the
 *    host_browser_request / host_browser_result round-trip.
 *  - Otherwise (CLI, tests, headless Chromium launched in-process),
 *    register a local backend that drives Playwright's CDPSession
 *    against the sacrificial-profile browser managed by
 *    browserManager.
 *
 * Both paths go through a per-invocation `BrowserSessionManager` so
 * the manager is the single choke point for CDP routing, session
 * lifetime, and (future) session invalidation handling. The returned
 * client is `kind`-tagged so tools can branch on transport — e.g.
 * browser_navigate skips Playwright-specific screencast and handoff
 * hooks when `kind === "extension"`.
 *
 * IMPORTANT: the returned client is per-invocation. Tools MUST call
 * `dispose()` in a finally block. Dispose tears down the manager's
 * session and the underlying CDP client. Disposing an extension-backed
 * client does NOT dispose the underlying HostBrowserProxy — that is
 * owned by the conversation.
 */
export function getCdpClient(context: ToolContext): ScopedCdpClient {
  const { conversationId, hostBrowserProxy } = context;
  if (hostBrowserProxy) {
    const client = createExtensionCdpClient(hostBrowserProxy, conversationId);
    const backend = createExtensionBackend({
      isAvailable: () => true,
      sendCdp: (command, signal) =>
        dispatchThroughClient(client, command, signal),
      dispose: () => client.dispose(),
    });
    return buildManagedClient("extension", conversationId, backend);
  }
  const client = createLocalCdpClient(conversationId);
  const backend = createLocalBackend({
    isAvailable: () => true,
    sendCdp: (command, signal) =>
      dispatchThroughClient(client, command, signal),
    dispose: () => client.dispose(),
  });
  return buildManagedClient("local", conversationId, backend);
}

/**
 * Build a ScopedCdpClient whose `send()` routes through a
 * BrowserSessionManager seeded with a single backend + session. This
 * lets tool call sites remain backend-agnostic while giving the
 * manager a seam for future session-invalidation and multi-target
 * routing work.
 */
function buildManagedClient(
  kind: CdpClientKind,
  conversationId: string,
  backend: BrowserBackend,
): ScopedCdpClient {
  const manager = new BrowserSessionManager({ backends: [backend] });
  const session = manager.createSession();
  let disposed = false;

  return {
    kind,
    conversationId,
    async send<T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<T> {
      if (disposed) {
        const clientName =
          kind === "extension"
            ? "ExtensionCdpClient"
            : kind === "cdp-inspect"
              ? "CdpInspectClient"
              : "LocalCdpClient";
        throw new CdpError("disposed", `${clientName} already disposed`, {
          cdpMethod: method,
          cdpParams: params,
        });
      }
      const command: CdpCommand = { method, params };
      const envelope = await manager.send(session.id, command, signal);
      return unwrapResult<T>(envelope, method, params);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // disposeAll() tears down the per-invocation backend (which in
      // turn disposes the underlying CdpClient) and clears the single
      // session we created in buildManagedClient.
      manager.disposeAll();
    },
  };
}

/**
 * Adapter that makes an existing `CdpClient` look like a
 * `BrowserBackend.send`. Converts thrown CdpErrors back into a
 * `CdpResult` envelope with an `error` payload so the manager does
 * not need to know about our thrown-error convention, then the
 * envelope is unwrapped again on the way out of the managed client.
 *
 * The per-command `command.sessionId` (populated by the manager from
 * a session's opaque `targetId`) is intentionally not forwarded to
 * the underlying CdpClient today — both LocalCdpClient and
 * ExtensionCdpClient take their CDP sessionId at construction time
 * and tools run one client per invocation. The seam is preserved so
 * a future multi-target backend can read it off the CdpCommand.
 */
async function dispatchThroughClient(
  client: CdpClient,
  command: CdpCommand,
  signal: AbortSignal | undefined,
): Promise<CdpResult> {
  try {
    const result = await client.send(command.method, command.params, signal);
    return { result };
  } catch (err) {
    if (err instanceof CdpError) {
      // Preserve the original CdpError so unwrapResult can re-throw it
      // verbatim. CdpResult's error channel is opaque to the manager,
      // so stashing the instance under `data` is safe.
      return {
        error: {
          code: -1,
          message: err.message,
          data: err,
        },
      };
    }
    throw err;
  }
}

/**
 * Unwrap a CdpResult envelope into the raw CDP result `T` or throw
 * the underlying CdpError. If the envelope carries an error but the
 * `data` is not a CdpError (e.g. a future backend surfaces a JSON-RPC
 * error envelope directly), synthesize a transport_error CdpError so
 * call sites keep their uniform error handling.
 */
function unwrapResult<T>(
  envelope: CdpResult,
  method: string,
  params?: Record<string, unknown>,
): T {
  if (envelope.error) {
    if (envelope.error.data instanceof CdpError) {
      throw envelope.error.data;
    }
    throw new CdpError("cdp_error", envelope.error.message, {
      cdpMethod: method,
      cdpParams: params,
      underlying: envelope.error,
    });
  }
  return envelope.result as T;
}

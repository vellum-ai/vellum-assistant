import {
  type BrowserBackend,
  BrowserSessionManager,
  type CdpCommand,
  type CdpResult,
  createCdpInspectBackend,
  createExtensionBackend,
  createLocalBackend,
} from "../../../browser-session/index.js";
import { getConfig } from "../../../config/loader.js";
import { getLogger } from "../../../util/logger.js";
import type { ToolContext } from "../../types.js";
import { createCdpInspectClient } from "./cdp-inspect-client.js";
import { CdpError } from "./errors.js";
import { createExtensionCdpClient } from "./extension-cdp-client.js";
import { createLocalCdpClient } from "./local-cdp-client.js";
import type {
  BackendCandidate,
  CdpClient,
  CdpClientKind,
  ScopedCdpClient,
} from "./types.js";

const log = getLogger("cdp-factory");

/**
 * Select the appropriate CdpClient implementation for a tool
 * invocation based on the ToolContext and config. Three backends are
 * considered in priority order:
 *
 *  1. **Extension** -- When `context.hostBrowserProxy` is set AND
 *     `hostBrowserProxy.isAvailable()` returns `true` (i.e. the
 *     proxy exists and the client is actually connected). This
 *     prevents selecting the extension transport when the proxy
 *     object exists but the underlying WebSocket is disconnected.
 *  2. **cdp-inspect** -- When `hostBrowser.cdpInspect.enabled` is
 *     `true` in config, construct a `CdpInspectClient` that attaches
 *     to an already-running Chrome via the DevTools JSON protocol.
 *  3. **Local** -- Default. Drives Playwright's CDPSession against
 *     the sacrificial-profile browser managed by browserManager.
 *
 * The factory builds an ordered candidate list and returns a
 * {@link ScopedCdpClient} with per-invocation failover semantics:
 *
 *  - On the first `send()`, the top-ranked candidate is selected and
 *    its backend is materialised.
 *  - If the first command fails with a **transport-level** error
 *    (`transport_error`), the factory tears down the failed backend
 *    and retries the same command against the next candidate.
 *  - **CDP protocol errors** (`cdp_error`) do NOT trigger failover --
 *    they indicate the browser understood the command and rejected it,
 *    so hopping transports would not help.
 *  - After the first successful CDP command, the backend becomes
 *    **sticky** for the remainder of the invocation. Subsequent
 *    commands always route through the same backend so multi-command
 *    tool flows do not hop transports mid-step.
 *
 * IMPORTANT: the returned client is per-invocation. Tools MUST call
 * `dispose()` in a finally block. Dispose tears down the manager's
 * session and the underlying CDP client. Disposing an extension-backed
 * client does NOT dispose the underlying HostBrowserProxy -- that is
 * owned by the conversation.
 */
export function getCdpClient(context: ToolContext): ScopedCdpClient {
  const candidates = buildCandidateList(context);

  log.debug(
    {
      conversationId: context.conversationId,
      candidates: candidates.map((c) => ({ kind: c.kind, reason: c.reason })),
    },
    "CDP factory: built candidate list",
  );

  return buildChainedClient(context.conversationId, candidates);
}

// ---------------------------------------------------------------------------
// Candidate list construction
// ---------------------------------------------------------------------------

/**
 * Build an ordered list of backend candidates from the tool context
 * and config. Candidates are evaluated lazily -- `create()` is only
 * called when the candidate is actually selected.
 *
 * Exported for testing.
 */
export function buildCandidateList(context: ToolContext): BackendCandidate[] {
  const { conversationId, hostBrowserProxy } = context;
  const candidates: BackendCandidate[] = [];

  // 1. Extension -- preferred when a chrome-extension is bound AND
  //    the proxy reports it is connected. Checking isAvailable()
  //    prevents selecting the extension transport when the proxy
  //    object exists (e.g. it was provisioned at conversation start)
  //    but the client has since disconnected.
  if (hostBrowserProxy && hostBrowserProxy.isAvailable()) {
    candidates.push({
      kind: "extension",
      reason: "hostBrowserProxy present and available",
      create() {
        const client = createExtensionCdpClient(
          hostBrowserProxy,
          conversationId,
        );
        const backend = createExtensionBackend({
          isAvailable: () => true,
          sendCdp: (command, signal) =>
            dispatchThroughClient(client, command, signal),
          dispose: () => client.dispose(),
        });
        return { client, backend };
      },
    });
  } else if (hostBrowserProxy) {
    log.debug(
      { conversationId },
      "CDP factory: hostBrowserProxy present but not available, skipping extension candidate",
    );
  }

  // 2. cdp-inspect -- opt-in via config.
  const cdpInspectConfig = getConfig().hostBrowser.cdpInspect;
  if (cdpInspectConfig.enabled) {
    candidates.push({
      kind: "cdp-inspect",
      reason: "cdpInspect enabled in config",
      create() {
        const client = createCdpInspectClient(conversationId, {
          host: cdpInspectConfig.host,
          port: cdpInspectConfig.port,
          discoveryTimeoutMs: cdpInspectConfig.probeTimeoutMs,
        });
        const backend = createCdpInspectBackend({
          isAvailable: () => true,
          sendCdp: (command, signal) =>
            dispatchThroughClient(client, command, signal),
          dispose: () => client.dispose(),
        });
        return { client, backend };
      },
    });
  }

  // 3. Local -- always present as the final fallback.
  candidates.push({
    kind: "local",
    reason: "default Playwright fallback",
    create() {
      const client = createLocalCdpClient(conversationId);
      const backend = createLocalBackend({
        isAvailable: () => true,
        sendCdp: (command, signal) =>
          dispatchThroughClient(client, command, signal),
        dispose: () => client.dispose(),
      });
      return { client, backend };
    },
  });

  return candidates;
}

// ---------------------------------------------------------------------------
// Chained client with per-invocation failover
// ---------------------------------------------------------------------------

/**
 * Build a {@link ScopedCdpClient} that walks the candidate list on
 * the first command, failing over on transport-level errors, and
 * becomes sticky after the first successful CDP command.
 *
 * Exported for testing.
 */
export function buildChainedClient(
  conversationId: string,
  candidates: BackendCandidate[],
): ScopedCdpClient {
  if (candidates.length === 0) {
    throw new Error("CDP factory: no backend candidates available");
  }

  /** Active backend state -- populated after first successful command. */
  let active: {
    kind: CdpClientKind;
    manager: BrowserSessionManager;
    sessionId: string;
  } | null = null;

  /** Set to true after the first successful CDP command. */
  let sticky = false;

  let disposed = false;

  /**
   * Track all materialised backends so dispose() can tear them all
   * down, even ones that were tried and failed before the sticky
   * backend was established.
   */
  const materialisedManagers: BrowserSessionManager[] = [];

  /**
   * The kind of the currently active (or last attempted) backend.
   * Before the first send this reflects the first candidate; after
   * the sticky backend is established it reflects the chosen kind.
   */
  let currentKind: CdpClientKind = candidates[0].kind;

  const scopedClient: ScopedCdpClient = {
    get kind(): CdpClientKind {
      return active?.kind ?? currentKind;
    },
    conversationId,

    async send<T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<T> {
      if (disposed) {
        throw new CdpError("disposed", "CdpClient already disposed", {
          cdpMethod: method,
          cdpParams: params,
        });
      }

      // Fast path: backend is already sticky -- route directly.
      if (sticky && active) {
        const command: CdpCommand = { method, params };
        const envelope = await active.manager.send(
          active.sessionId,
          command,
          signal,
        );
        return unwrapResult<T>(envelope, method, params);
      }

      // Slow path: walk the candidate list with failover.
      return sendWithFailover<T>(
        candidates,
        materialisedManagers,
        method,
        params,
        signal,
        (established) => {
          active = established;
          sticky = true;
          currentKind = established.kind;
        },
        () => disposed,
        conversationId,
      );
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const m of materialisedManagers) {
        m.disposeAll();
      }
      materialisedManagers.length = 0;
      active = null;
    },
  };

  return scopedClient;
}

/**
 * Walk the candidate list attempting to execute a single CDP command.
 * Transport-level failures trigger failover to the next candidate;
 * CDP protocol errors propagate immediately.
 */
async function sendWithFailover<T>(
  candidates: BackendCandidate[],
  materialisedManagers: BrowserSessionManager[],
  method: string,
  params: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
  onEstablished: (active: {
    kind: CdpClientKind;
    manager: BrowserSessionManager;
    sessionId: string;
  }) => void,
  isDisposed: () => boolean,
  conversationId: string,
): Promise<T> {
  let lastError: CdpError | undefined;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (isDisposed()) {
      throw new CdpError("disposed", "CdpClient already disposed", {
        cdpMethod: method,
        cdpParams: params,
      });
    }

    log.debug(
      {
        conversationId,
        candidateKind: candidate.kind,
        candidateIndex: i,
        method,
      },
      "CDP factory: attempting candidate",
    );

    let backend: BrowserBackend;
    try {
      const created = candidate.create();
      backend = created.backend;
    } catch (err) {
      // Backend construction failed -- treat as transport error and
      // try the next candidate.
      log.debug(
        { conversationId, candidateKind: candidate.kind, err },
        "CDP factory: candidate construction failed, trying next",
      );
      lastError = new CdpError(
        "transport_error",
        `Backend ${candidate.kind} construction failed: ${err instanceof Error ? err.message : String(err)}`,
        { cdpMethod: method, cdpParams: params, underlying: err },
      );
      continue;
    }

    const manager = new BrowserSessionManager({ backends: [backend] });
    materialisedManagers.push(manager);
    const session = manager.createSession();

    const command: CdpCommand = { method, params };
    let envelope: CdpResult;
    try {
      envelope = await manager.send(session.id, command, signal);
    } catch (err) {
      // Manager-level errors (unknown session, no available backend)
      // are transport-level problems -- try the next candidate.
      log.debug(
        { conversationId, candidateKind: candidate.kind, err },
        "CDP factory: candidate send threw, trying next",
      );
      manager.disposeAll();
      lastError = new CdpError(
        "transport_error",
        `Backend ${candidate.kind} send threw: ${err instanceof Error ? err.message : String(err)}`,
        { cdpMethod: method, cdpParams: params, underlying: err },
      );
      continue;
    }

    // Inspect the envelope for errors. Transport-level errors trigger
    // failover; CDP protocol errors propagate immediately.
    if (envelope.error) {
      const cdpError = extractCdpError(envelope, method, params);

      if (isTransportFailover(cdpError) && i < candidates.length - 1) {
        log.debug(
          {
            conversationId,
            candidateKind: candidate.kind,
            errorCode: cdpError.code,
            errorMessage: cdpError.message,
          },
          "CDP factory: transport-level failure, failing over to next candidate",
        );
        manager.disposeAll();
        lastError = cdpError;
        continue;
      }

      // Either a CDP protocol error or we've exhausted candidates --
      // propagate the error as-is.
      throw cdpError;
    }

    // Success! Establish this backend as the sticky choice.
    log.debug(
      { conversationId, candidateKind: candidate.kind, method },
      "CDP factory: candidate succeeded, backend is now sticky",
    );
    onEstablished({ kind: candidate.kind, manager, sessionId: session.id });
    return envelope.result as T;
  }

  // All candidates exhausted -- throw the last transport error.
  throw (
    lastError ??
    new CdpError("transport_error", "All backend candidates exhausted", {
      cdpMethod: method,
      cdpParams: params,
    })
  );
}

/**
 * Determine whether a CdpError should trigger failover to the next
 * candidate. Only transport-level failures are eligible -- CDP
 * protocol errors indicate the browser understood the command and
 * rejected it, so retrying on a different transport would not help.
 */
function isTransportFailover(err: CdpError): boolean {
  return err.code === "transport_error";
}

// ---------------------------------------------------------------------------
// Helpers (shared with the old implementation)
// ---------------------------------------------------------------------------

/**
 * Extract a CdpError from a CdpResult envelope that carries an error.
 */
function extractCdpError(
  envelope: CdpResult,
  method: string,
  params?: Record<string, unknown>,
): CdpError {
  if (envelope.error?.data instanceof CdpError) {
    return envelope.error.data;
  }
  return new CdpError(
    "cdp_error",
    envelope.error?.message ?? "Unknown CDP error",
    {
      cdpMethod: method,
      cdpParams: params,
      underlying: envelope.error,
    },
  );
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
 * the underlying CdpClient today -- both LocalCdpClient and
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
      // Preserve the original CdpError so extractCdpError can
      // re-throw it verbatim. CdpResult's error channel is opaque
      // to the manager, so stashing the instance under `data` is safe.
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
    throw extractCdpError(envelope, method, params);
  }
  return envelope.result as T;
}

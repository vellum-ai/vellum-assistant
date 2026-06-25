import {
  type BrowserBackend,
  BrowserSessionManager,
  type CdpCommand,
  type CdpResult,
  createCdpInspectBackend,
  createExtensionBackend,
  createHostBridgeBackend,
  createLocalBackend,
} from "../../../browser-session/index.js";
import { getConfig } from "../../../config/loader.js";
import { HostBrowserProxy } from "../../../daemon/host-browser-proxy.js";
import { getLogger } from "../../../util/logger.js";
import type { ToolContext } from "../../types.js";
import { getPinnedTab } from "../pinned-tabs.js";
import { createCdpInspectClient } from "./cdp-inspect-client.js";
import { CdpError } from "./errors.js";
import { createExtensionCdpClient } from "./extension-cdp-client.js";
import { createHostBridgeCdpClient } from "./host-bridge-cdp-client.js";
import { createLocalCdpClient } from "./local-cdp-client.js";
import type {
  AttemptDiagnostic,
  BackendCandidate,
  CdpClient,
  CdpClientKind,
  InternalBrowserMode,
  ScopedCdpClient,
  TabInfo,
} from "./types.js";

const log = getLogger("cdp-factory");

// ---------------------------------------------------------------------------
// Desktop-auto cdp-inspect cooldown tracker
// ---------------------------------------------------------------------------

/**
 * Module-level timestamp (epoch ms) of the last transport-level failure for
 * a desktop-auto cdp-inspect attempt. While `Date.now() - _desktopAutoCooldownSince`
 * is less than the configured `desktopAuto.cooldownMs`, the factory skips the
 * automatic cdp-inspect candidate and goes straight to the local backend.
 *
 * **Process-global scope**: this is a module-level singleton that affects ALL
 * conversations in the process. A cdp-inspect failure on any conversation
 * suppresses desktop-auto probes for every conversation in this daemon until
 * the cooldown expires. This is intentional -- the local loopback CDP
 * endpoint is per-machine, not per-conversation, so a failure on one
 * conversation implies all others would fail the same way.
 *
 * Reset to 0 when the cooldown expires or when manually cleared via
 * {@link _resetDesktopAutoCooldown} (for testing).
 */
let _desktopAutoCooldownSince = 0;

/**
 * Record a cooldown after a desktop-auto cdp-inspect transport failure.
 * Called by {@link maybeRecordCandidateCooldown} in production; also
 * exported directly for use in tests.
 */
export function recordDesktopAutoCooldown(): void {
  _desktopAutoCooldownSince = Date.now();
}

/**
 * Whether the desktop-auto cdp-inspect cooldown is currently active.
 * Returns `true` if a failure was recorded and the configured cooldown
 * window has not yet elapsed.
 */
export function isDesktopAutoCooldownActive(cooldownMs: number): boolean {
  if (_desktopAutoCooldownSince === 0 || cooldownMs <= 0) return false;
  return Date.now() - _desktopAutoCooldownSince < cooldownMs;
}

/**
 * Reset the desktop-auto cooldown state. Exported for testing only.
 */
export function _resetDesktopAutoCooldown(): void {
  _desktopAutoCooldownSince = 0;
}

/**
 * Get the raw cooldown-since timestamp. Exported for testing only.
 */
export function _getDesktopAutoCooldownSince(): number {
  return _desktopAutoCooldownSince;
}

// ---------------------------------------------------------------------------
// Host-bridge cooldown tracker
// ---------------------------------------------------------------------------

/**
 * Per-actor timestamps (epoch ms) of the last transport-level failure
 * for a host-bridge attempt. Mirrors the desktop-auto cdp-inspect
 * cooldown above — the failure root cause is the same (the user's
 * Chrome is not exposing a remote-debugging port), just probed through
 * the desktop SSE bridge instead of directly. While the configured
 * `desktopAuto.cooldownMs` window has not elapsed, the factory skips
 * the host-bridge candidate so every browser op doesn't pay an SSE
 * round-trip for a guaranteed failure.
 *
 * **Per-actor scope**: unlike the desktop-auto cooldown (one local
 * machine, so process-global is correct), the bridge reaches a
 * different desktop machine per actor on a multi-actor cloud daemon —
 * one actor's missing debug port must not suppress another actor's
 * only route to their own Chrome. Callers without a resolved actor
 * share the `__default__` slot.
 */
const _hostBridgeCooldownSince = new Map<string, number>();

/** Entries older than this are swept on record to bound map growth. */
const HOST_BRIDGE_COOLDOWN_SWEEP_MS = 60 * 60 * 1000;

function hostBridgeCooldownKey(sourceActorPrincipalId?: string): string {
  return sourceActorPrincipalId ?? "__default__";
}

/** Record a cooldown after a host-bridge transport failure for this actor. */
export function recordHostBridgeCooldown(
  sourceActorPrincipalId?: string,
): void {
  const now = Date.now();
  for (const [key, since] of _hostBridgeCooldownSince) {
    if (now - since >= HOST_BRIDGE_COOLDOWN_SWEEP_MS) {
      _hostBridgeCooldownSince.delete(key);
    }
  }
  _hostBridgeCooldownSince.set(
    hostBridgeCooldownKey(sourceActorPrincipalId),
    now,
  );
}

/**
 * Whether the host-bridge cooldown is currently active for this actor.
 * Returns `true` if a failure was recorded and the configured cooldown
 * window has not yet elapsed.
 */
export function isHostBridgeCooldownActive(
  cooldownMs: number,
  sourceActorPrincipalId?: string,
): boolean {
  if (cooldownMs <= 0) return false;
  const since = _hostBridgeCooldownSince.get(
    hostBridgeCooldownKey(sourceActorPrincipalId),
  );
  if (since === undefined) return false;
  return Date.now() - since < cooldownMs;
}

/** Reset the host-bridge cooldown state. Exported for testing only. */
export function _resetHostBridgeCooldown(): void {
  _hostBridgeCooldownSince.clear();
}

/** Get the raw cooldown-since timestamp for an actor. Exported for testing only. */
export function _getHostBridgeCooldownSince(
  sourceActorPrincipalId?: string,
): number {
  return (
    _hostBridgeCooldownSince.get(
      hostBridgeCooldownKey(sourceActorPrincipalId),
    ) ?? 0
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for {@link getCdpClient}. All fields are optional — omitting
 * them preserves the existing auto-mode behavior.
 */
export interface GetCdpClientOptions {
  /**
   * Backend mode preference. When omitted or `"auto"`, the factory
   * uses the existing priority-ordered fallback chain. When set to a
   * specific backend kind, the factory pins to that single backend
   * and disables failover. `"host-bridge"` is internal-only (sticky
   * conversation memo), never user-requestable.
   */
  mode?: InternalBrowserMode;
  /**
   * Explicit target client id. When provided, the extension backend routes
   * to this specific client instead of auto-resolving to the most-recently-
   * active same-actor host_browser client. Mirrors the `target_client_id`
   * pattern on host_bash/host_file/host_cu.
   */
  targetClientId?: string;
}

/**
 * Select the appropriate CdpClient implementation for a tool
 * invocation based on the ToolContext and config. Three backends are
 * considered in priority order:
 *
 *  1. **Extension** -- When `HostBrowserProxy.instance` is available
 *     and `isAvailable()` returns `true` (i.e. a chrome extension
 *     connection exists in the registry). This prevents selecting
 *     the extension transport when no extension is connected.
 *  2. **cdp-inspect** -- When `hostBrowser.cdpInspect.enabled` is
 *     `true` in config, construct a `CdpInspectClient` that attaches
 *     to an already-running Chrome via the DevTools JSON protocol.
 *     On macOS, cdp-inspect is also included automatically when
 *     `desktopAuto.enabled` is true (the default), even when the
 *     top-level `enabled` flag is false.
 *  3. **Local** -- Default. Drives Playwright's CDPSession against
 *     the sacrificial-profile browser managed by browserManager.
 *
 * When `options.mode` is set to a specific backend kind, the factory
 * builds exactly one candidate and disables failover. If the pinned
 * backend is unavailable (e.g. pinned `extension` without an
 * available host browser proxy), the factory throws a typed
 * `CdpError` with `transport_error` code and a diagnostic indicating
 * the precondition that was not met.
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
export function getCdpClient(
  context: ToolContext,
  options?: GetCdpClientOptions,
): ScopedCdpClient {
  const mode: InternalBrowserMode = options?.mode ?? "auto";
  const targetClientId = options?.targetClientId;
  const candidates =
    mode === "auto"
      ? buildCandidateList(context, targetClientId)
      : buildPinnedCandidateList(context, mode, targetClientId);

  log.debug(
    {
      conversationId: context.conversationId,
      mode,
      candidates: candidates.map((c) => ({ kind: c.kind, reason: c.reason })),
    },
    "CDP factory: built candidate list",
  );

  return buildChainedClient(context.conversationId, candidates, mode);
}

// ---------------------------------------------------------------------------
// Pinned candidate list construction
// ---------------------------------------------------------------------------

/**
 * Build a single-element candidate list for a pinned backend mode.
 * Throws a typed `CdpError` with structured diagnostics when the
 * requested backend's preconditions are not met.
 *
 * Exported for testing.
 */
export function buildPinnedCandidateList(
  context: ToolContext,
  mode: Exclude<InternalBrowserMode, "auto">,
  targetClientId?: string,
): BackendCandidate[] {
  const { conversationId, sourceActorPrincipalId } = context;

  switch (mode) {
    case "extension": {
        const hostBrowserProxy = HostBrowserProxy.instance;
        if (!hostBrowserProxy.hasExtensionClient(sourceActorPrincipalId)) {
          throw new CdpError(
            "transport_error",
            `Pinned mode "extension" unavailable: no Chrome Extension connected`,
            {
              attemptDiagnostics: [
                {
                  candidateKind: "extension",
                  inclusionReason: `pinned mode: extension`,
                  stage: "candidate_selection",
                  errorCode: "transport_error",
                  errorMessage: "no Chrome Extension connected",
                },
              ],
            },
          );
        }
        return [
        {
          kind: "extension",
          reason: "pinned mode: extension",
          create() {
            const client = createExtensionCdpClient(
              hostBrowserProxy,
              conversationId,
              // Pass clientId to scope the pin lookup to this specific
              // extension install. When a targetClientId is provided
              // the pin is fetched for that client; otherwise falls back
              // to the __default__ slot which is set by older callers
              // without clientId awareness.
              getPinnedTab(conversationId, targetClientId),
              sourceActorPrincipalId,
              targetClientId,
            );
            const backend = createExtensionBackend({
              isAvailable: () => true,
              sendCdp: (command, signal) =>
                dispatchThroughClient(client, command, signal),
              dispose: () => client.dispose(),
            });
            return { client, backend };
          },
        },
      ];
    }
    case "cdp-inspect": {
      const cdpInspectConfig = getConfig().hostBrowser.cdpInspect;
      return [
        {
          kind: "cdp-inspect",
          reason: "pinned mode: cdp-inspect",
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
        },
      ];
    }
    case "host-bridge": {
      // Reached only via the conversation's sticky-backend memo after a
      // successful bridge send — never via --browser-mode. Throwing when
      // an extension has since connected (not just when the bridge is
      // gone) deliberately trips the caller's sticky-fallback retry,
      // which clears the memo and re-runs auto mode so the conversation
      // upgrades to the extension candidate with correct kind labeling.
      const hostBrowserProxy = HostBrowserProxy.instance;
      if (
        !hostBrowserProxy.isAvailable(sourceActorPrincipalId) ||
        hostBrowserProxy.hasExtensionClient(sourceActorPrincipalId)
      ) {
        const errorMessage = hostBrowserProxy.hasExtensionClient(
          sourceActorPrincipalId,
        )
          ? "a Chrome Extension is now connected"
          : "no host_browser bridge client connected";
        throw new CdpError(
          "transport_error",
          `Pinned mode "host-bridge" unavailable: ${errorMessage}`,
          {
            attemptDiagnostics: [
              {
                candidateKind: "host-bridge",
                inclusionReason: "pinned mode: host-bridge",
                stage: "candidate_selection",
                errorCode: "transport_error",
                errorMessage,
              },
            ],
          },
        );
      }
      return [
        makeHostBridgeCandidate(
          hostBrowserProxy,
          conversationId,
          sourceActorPrincipalId,
          "pinned mode: host-bridge (conversation sticky memo)",
        ),
      ];
    }
    case "local": {
      return [
        {
          kind: "local",
          reason: "pinned mode: local",
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
        },
      ];
    }
    default: {
      // Exhaustive check — if new modes are added, TypeScript will
      // flag this as an error.
      const _exhaustive: never = mode;
      throw new Error(`Unknown pinned mode: ${_exhaustive}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Candidate list construction (auto mode)
// ---------------------------------------------------------------------------

/**
 * Build an ordered list of backend candidates from the tool context
 * and config. Candidates are evaluated lazily -- `create()` is only
 * called when the candidate is actually selected.
 *
 * Exported for testing.
 */
export function buildCandidateList(context: ToolContext, targetClientId?: string): BackendCandidate[] {
  const { conversationId, sourceActorPrincipalId } = context;
  const candidates: BackendCandidate[] = [];
  const hostBrowserProxy = HostBrowserProxy.instance;

  // When a specific host client is targeted, only the extension proxy can
  // route to it. Skip the fallback chain entirely: if the extension is
  // unavailable, fail loudly rather than silently routing to a different
  // browser.
  if (targetClientId != null) {
    if (!hostBrowserProxy.hasExtensionClient(sourceActorPrincipalId)) {
      throw new CdpError(
        "transport_error",
        `Cannot reach target_client_id "${targetClientId}": no Chrome Extension connected`,
        {
          attemptDiagnostics: [
            {
              candidateKind: "extension",
              inclusionReason: "target_client_id requires extension proxy",
              stage: "candidate_selection",
              errorCode: "transport_error",
              errorMessage: "no Chrome Extension connected",
            },
          ],
        },
      );
    }
    return [
      {
        kind: "extension",
        reason: `target_client_id override: ${targetClientId}`,
        create() {
          // Explicit target_client_id override → look up the pin scoped
          // to this specific client. This is safe because targetClientId
          // and the pin were both recorded for the same extension install.
          const client = createExtensionCdpClient(
            hostBrowserProxy,
            conversationId,
            getPinnedTab(conversationId, targetClientId),
            sourceActorPrincipalId,
            targetClientId,
          );
          const backend = createExtensionBackend({
            isAvailable: () => true,
            sendCdp: (command, signal) =>
              dispatchThroughClient(client, command, signal),
            dispose: () => client.dispose(),
          });
          return { client, backend };
        },
      },
    ];
  }

  // 1. Extension -- preferred when a Chrome Extension client is connected.
  // Availability checks are actor-scoped: on a multi-actor cloud daemon,
  // another actor's extension must not select extension-labelled
  // transports for this conversation (the proxy would refuse to
  // dispatch to it anyway).
  if (hostBrowserProxy.hasExtensionClient(sourceActorPrincipalId)) {
    candidates.push({
      kind: "extension",
      reason: "Chrome Extension connected via registry singleton",
      create() {
        const client = createExtensionCdpClient(
          hostBrowserProxy,
          conversationId,
          // targetClientId is always undefined here — this code path
          // only runs when targetClientId is null (the early-return
          // above handles the non-null case). Use the no-clientId
          // lookup which returns the first pin for auto-routing.
          getPinnedTab(conversationId),
          sourceActorPrincipalId,
          targetClientId,
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
  } else if (hostBrowserProxy.isAvailable(sourceActorPrincipalId)) {
    // 1b. Host bridge -- a host_browser-capable client (the desktop SSE
    // bridge) is connected but no Chrome Extension. Raw CDP commands are
    // proxied to the user's machine and executed against Chrome's local
    // remote-debugging port. This is the only route to the user's own
    // Chrome when the daemon runs remotely (cloud), where cdp-inspect
    // would dial the daemon's localhost instead.
    const { cooldownMs } = getConfig().hostBrowser.cdpInspect.desktopAuto;
    if (isHostBridgeCooldownActive(cooldownMs, sourceActorPrincipalId)) {
      log.debug(
        {
          conversationId,
          cooldownMs,
          cooldownSince: _getHostBridgeCooldownSince(sourceActorPrincipalId),
        },
        "CDP factory: host-bridge skipped (cooldown active)",
      );
    } else {
      candidates.push(
        makeHostBridgeCandidate(
          hostBrowserProxy,
          conversationId,
          sourceActorPrincipalId,
          "host_browser bridge connected (no Chrome Extension); raw CDP via desktop SSE bridge",
        ),
      );
    }
  } else {
    log.debug(
      { conversationId },
      "CDP factory: no Chrome Extension connected, skipping extension candidate",
    );
  }

  // 2. cdp-inspect -- opt-in via config OR desktop-auto for macOS turns.
  const cdpInspectConfig = getConfig().hostBrowser.cdpInspect;
  if (cdpInspectConfig.enabled) {
    // Explicitly enabled in config -- always include regardless of platform.
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
  } else if (
    context.transportInterface === "macos" &&
    cdpInspectConfig.desktopAuto.enabled
  ) {
    // macOS desktop-auto: include cdp-inspect as a candidate unless
    // the cooldown from a recent failure is still active. The extension
    // candidate is already first in the list, so it wins when connected.
    const { cooldownMs } = cdpInspectConfig.desktopAuto;
    if (isDesktopAutoCooldownActive(cooldownMs)) {
      log.debug(
        {
          conversationId,
          cooldownMs,
          cooldownSince: _desktopAutoCooldownSince,
        },
        "CDP factory: desktop-auto cdp-inspect skipped (cooldown active)",
      );
    } else {
      candidates.push({
        kind: "cdp-inspect",
        reason: "desktopAuto: macOS turn, cdp-inspect auto-attempted",
        create() {
          const client = createCdpInspectClient(conversationId, {
            host: cdpInspectConfig.host,
            port: cdpInspectConfig.port,
            discoveryTimeoutMs: cdpInspectConfig.probeTimeoutMs,
            wsConnectTimeoutMs: cdpInspectConfig.probeTimeoutMs,
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

/**
 * Build the host-bridge backend candidate. Shared between auto mode
 * (no extension connected, bridge available) and the pinned path that
 * serves the conversation's sticky-backend memo.
 *
 * Unlike the extension candidate, no pinned tab is passed: extension
 * pins store Chrome tab ids, which never match the CDP target ids the
 * bridge resolves from /json/list.
 */
function makeHostBridgeCandidate(
  hostBrowserProxy: HostBrowserProxy,
  conversationId: string,
  sourceActorPrincipalId: string | undefined,
  reason: string,
): BackendCandidate {
  return {
    kind: "host-bridge",
    reason,
    sourceActorPrincipalId,
    create() {
      const client = createHostBridgeCdpClient(
        hostBrowserProxy,
        conversationId,
        sourceActorPrincipalId,
      );
      const backend = createHostBridgeBackend({
        isAvailable: () => true,
        sendCdp: (command, signal) =>
          dispatchThroughClient(client, command, signal),
        dispose: () => client.dispose(),
      });
      return { client, backend };
    },
  };
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
  mode: InternalBrowserMode = "auto",
): ScopedCdpClient {
  if (candidates.length === 0) {
    throw new Error("CDP factory: no backend candidates available");
  }

  /** Active backend state -- populated after first successful command. */
  let active: {
    kind: CdpClientKind;
    manager: BrowserSessionManager;
    sessionId: string;
    /**
     * Reference to the underlying CdpClient (returned from
     * `candidate.create()`). Held so callers can reach methods that
     * aren't routed through `manager.send()` — specifically
     * {@link CdpClient.setCdpSessionId}, which re-targets follow-on
     * CDP commands at a specific tab/target. Without this we'd have
     * no way to call setCdpSessionId on the materialised client
     * since `backend` only exposes the send/dispose surface.
     */
    client: CdpClient;
  } | null = null;

  /** Set to true after the first successful CDP command. */
  let sticky = false;

  let disposed = false;

  /**
   * setCdpSessionId may be called BEFORE the first send (i.e. before
   * `active` is populated). When that happens we stash the value
   * here and apply it to `active.client` as soon as a backend becomes
   * sticky. In the current --new-tab flow this can't trigger (the
   * createTab send establishes sticky first, then setCdpSessionId is
   * called), but supporting the pre-sticky case keeps the contract
   * simple for future callers.
   */
  let pendingCdpSessionId: string | undefined;

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
          // Flush any pre-sticky setCdpSessionId call onto the
          // freshly-materialised client. See pendingCdpSessionId
          // comment above for why this exists.
          if (
            pendingCdpSessionId !== undefined &&
            established.client.setCdpSessionId
          ) {
            established.client.setCdpSessionId(pendingCdpSessionId);
            pendingCdpSessionId = undefined;
          }
        },
        () => disposed,
        conversationId,
        mode,
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

    /**
     * Re-target follow-on CDP commands at a specific tab/target by
     * updating the underlying client's `cdpSessionId`. The navigate
     * executor calls this after `Vellum.createTab` returns so the
     * subsequent `Page.navigate` (and every command on this
     * conversation thereafter) routes to the new tab instead of the
     * currently-active tab.
     *
     * Behaviour by state:
     * - Sticky backend already established → forward to
     *   `active.client.setCdpSessionId` if the underlying client
     *   implements it (extension does; local/cdp-inspect don't and
     *   the optional chain no-ops).
     * - No sticky backend yet → stash the value; it gets applied
     *   in the `onEstablished` callback when the first send walks
     *   the candidate list.
     */
    setCdpSessionId(cdpSessionId: string | undefined): void {
      if (active?.client.setCdpSessionId) {
        active.client.setCdpSessionId(cdpSessionId);
        return;
      }
      pendingCdpSessionId = cdpSessionId;
    },

    async listTabs(): Promise<TabInfo[]> {
      if (sticky && active?.client.listTabs) {
        return active.client.listTabs();
      }
      if (sticky) {
        throw new CdpError(
          "transport_error",
          "listTabs is not supported by the current backend (extension backend required)",
        );
      }
      // Fresh client: route through the failover walk so the extension
      // backend is selected automatically. The Vellum.listTabs pseudo-method
      // is handled by the extension dispatcher before chrome.debugger.sendCommand.
      const result = await scopedClient.send<{ tabs?: TabInfo[] }>("Vellum.listTabs", {});
      if (!active?.client.listTabs) {
        // Backend became sticky but isn't an extension client — not supported.
        throw new CdpError(
          "transport_error",
          "listTabs is not supported by the current backend (extension backend required)",
        );
      }
      return Array.isArray(result?.tabs) ? result.tabs : [];
    },

    async selectTab(tabId: number): Promise<{
      tabId?: number;
      windowId?: number;
      url?: string;
      title?: string;
      clientId?: string;
    }> {
      if (sticky && active?.client.selectTab) {
        return active.client.selectTab(tabId);
      }
      if (sticky) {
        throw new CdpError(
          "transport_error",
          "selectTab is not supported by the current backend (extension backend required)",
        );
      }
      const result = await scopedClient.send<{
        tabId?: number;
        windowId?: number;
        url?: string;
        title?: string;
        clientId?: string;
      }>("Vellum.selectTab", { tabId });
      if (!active?.client.selectTab) {
        throw new CdpError(
          "transport_error",
          "selectTab is not supported by the current backend (extension backend required)",
        );
      }
      return result;
    },

    async closeTab(tabId: number): Promise<{
      closed: boolean;
      tabId: number;
      clientId?: string;
    }> {
      if (sticky && active?.client.closeTab) {
        return active.client.closeTab(tabId);
      }
      if (sticky) {
        throw new CdpError(
          "transport_error",
          "closeTab is not supported by the current backend (extension backend required)",
        );
      }
      const result = await scopedClient.send<{
        closed: boolean;
        tabId: number;
        clientId?: string;
      }>("Vellum.closeTab", { tabId });
      if (!active?.client.closeTab) {
        throw new CdpError(
          "transport_error",
          "closeTab is not supported by the current backend (extension backend required)",
        );
      }
      return result;
    },
  };

  return scopedClient;
}

/**
 * Walk the candidate list attempting to execute a single CDP command.
 * Transport-level failures trigger failover to the next candidate;
 * CDP protocol errors propagate immediately.
 *
 * When a desktop-auto cdp-inspect candidate fails with a transport
 * error, the factory records a cooldown so subsequent calls skip the
 * probe until the window expires.
 *
 * In auto mode, each attempted candidate is recorded as an
 * {@link AttemptDiagnostic}. When fallback occurs, a production-visible
 * log is emitted with the full candidate sequence and per-candidate
 * failure reasons. If all candidates are exhausted, the diagnostics
 * are attached to the thrown {@link CdpError}.
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
    client: CdpClient;
  }) => void,
  isDisposed: () => boolean,
  conversationId: string,
  mode: InternalBrowserMode,
): Promise<T> {
  let lastError: CdpError | undefined;
  const diagnostics: AttemptDiagnostic[] = [];

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
    let underlyingClient: CdpClient;
    try {
      const created = candidate.create();
      backend = created.backend;
      // Hold the underlying CdpClient so we can forward
      // setCdpSessionId calls to it after the backend becomes
      // sticky. Without this the scopedClient's setCdpSessionId
      // method has no way to reach the materialised client (the
      // BrowserSessionManager only exposes a send/dispose surface).
      underlyingClient = created.client;
    } catch (err) {
      // Backend construction failed -- treat as transport error and
      // try the next candidate.
      const errorMessage = `Backend ${candidate.kind} construction failed: ${err instanceof Error ? err.message : String(err)}`;
      log.debug(
        { conversationId, candidateKind: candidate.kind, err },
        "CDP factory: candidate construction failed, trying next",
      );
      lastError = new CdpError("transport_error", errorMessage, {
        cdpMethod: method,
        cdpParams: params,
        underlying: err,
      });
      diagnostics.push({
        candidateKind: candidate.kind,
        inclusionReason: candidate.reason,
        stage: "construction",
        errorCode: "transport_error",
        errorMessage,
      });
      maybeRecordCandidateCooldown(candidate);

      // Emit production-visible fallback log in auto mode
      if (mode === "auto" && i < candidates.length - 1) {
        log.warn(
          {
            conversationId,
            failedCandidate: candidate.kind,
            nextCandidate: candidates[i + 1].kind,
            attemptedSoFar: diagnostics.map((d) => ({
              kind: d.candidateKind,
              stage: d.stage,
              errorCode: d.errorCode,
              errorMessage: d.errorMessage,
            })),
          },
          "CDP factory: auto-mode fallback triggered",
        );
      }
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
      const errorMessage = `Backend ${candidate.kind} send threw: ${err instanceof Error ? err.message : String(err)}`;
      log.debug(
        { conversationId, candidateKind: candidate.kind, err },
        "CDP factory: candidate send threw, trying next",
      );
      manager.disposeAll();
      lastError = new CdpError("transport_error", errorMessage, {
        cdpMethod: method,
        cdpParams: params,
        underlying: err,
      });
      diagnostics.push({
        candidateKind: candidate.kind,
        inclusionReason: candidate.reason,
        stage: "send",
        errorCode: "transport_error",
        errorMessage,
        discoveryCode: extractDiscoveryCode(err),
      });
      maybeRecordCandidateCooldown(candidate);

      // Emit production-visible fallback log in auto mode
      if (mode === "auto" && i < candidates.length - 1) {
        log.warn(
          {
            conversationId,
            failedCandidate: candidate.kind,
            nextCandidate: candidates[i + 1].kind,
            attemptedSoFar: diagnostics.map((d) => ({
              kind: d.candidateKind,
              stage: d.stage,
              errorCode: d.errorCode,
              errorMessage: d.errorMessage,
            })),
          },
          "CDP factory: auto-mode fallback triggered",
        );
      }
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
        diagnostics.push({
          candidateKind: candidate.kind,
          inclusionReason: candidate.reason,
          stage: "send",
          errorCode: cdpError.code,
          errorMessage: cdpError.message,
          discoveryCode: extractDiscoveryCode(cdpError.underlying),
        });
        maybeRecordCandidateCooldown(candidate);

        // Emit production-visible fallback log in auto mode
        if (mode === "auto") {
          log.warn(
            {
              conversationId,
              failedCandidate: candidate.kind,
              nextCandidate: candidates[i + 1].kind,
              attemptedSoFar: diagnostics.map((d) => ({
                kind: d.candidateKind,
                stage: d.stage,
                errorCode: d.errorCode,
                errorMessage: d.errorMessage,
              })),
            },
            "CDP factory: auto-mode fallback triggered",
          );
        }
        continue;
      }

      // Either a CDP protocol error or we've exhausted candidates --
      // propagate the error as-is, attaching diagnostics.
      diagnostics.push({
        candidateKind: candidate.kind,
        inclusionReason: candidate.reason,
        stage: "send",
        errorCode: cdpError.code,
        errorMessage: cdpError.message,
        discoveryCode: extractDiscoveryCode(cdpError.underlying),
      });
      throw new CdpError(cdpError.code, cdpError.message, {
        cdpMethod: cdpError.cdpMethod,
        cdpParams: cdpError.cdpParams,
        underlying: cdpError.underlying,
        attemptDiagnostics: diagnostics.length > 0 ? diagnostics : undefined,
      });
    }

    // Success! Establish this backend as the sticky choice.
    diagnostics.push({
      candidateKind: candidate.kind,
      inclusionReason: candidate.reason,
      stage: "success",
    });

    // If there were prior failed candidates in auto mode, log the
    // full sequence for observability.
    if (mode === "auto" && diagnostics.length > 1) {
      log.warn(
        {
          conversationId,
          stickyCandidate: candidate.kind,
          attemptSequence: diagnostics.map((d) => ({
            kind: d.candidateKind,
            stage: d.stage,
            errorCode: d.errorCode,
            errorMessage: d.errorMessage,
          })),
        },
        "CDP factory: auto-mode fallback completed, backend established after retries",
      );
    }

    log.debug(
      { conversationId, candidateKind: candidate.kind, method },
      "CDP factory: candidate succeeded, backend is now sticky",
    );
    onEstablished({
      kind: candidate.kind,
      manager,
      sessionId: session.id,
      client: underlyingClient,
    });
    return envelope.result as T;
  }

  // All candidates exhausted -- throw the last transport error with
  // full attempt diagnostics attached.
  throw lastError
    ? new CdpError(lastError.code, lastError.message, {
        cdpMethod: lastError.cdpMethod,
        cdpParams: lastError.cdpParams,
        underlying: lastError.underlying,
        attemptDiagnostics: diagnostics.length > 0 ? diagnostics : undefined,
      })
    : new CdpError("transport_error", "All backend candidates exhausted", {
        cdpMethod: method,
        cdpParams: params,
        attemptDiagnostics: diagnostics.length > 0 ? diagnostics : undefined,
      });
}

/**
 * Record the appropriate cooldown for a failed candidate so subsequent
 * calls skip the probe: desktop-auto cdp-inspect attempts (matched by
 * reason prefix, exempting user-pinned cdp-inspect) and host-bridge
 * attempts (matched by kind alone — the bridge is never user-pinned).
 */
function maybeRecordCandidateCooldown(candidate: BackendCandidate): void {
  if (candidate.kind === "host-bridge") {
    log.debug(
      "CDP factory: recording host-bridge cooldown after transport failure",
    );
    recordHostBridgeCooldown(candidate.sourceActorPrincipalId);
    return;
  }
  if (
    candidate.kind === "cdp-inspect" &&
    candidate.reason.startsWith("desktopAuto:")
  ) {
    log.debug(
      "CDP factory: recording desktop-auto cdp-inspect cooldown after transport failure",
    );
    recordDesktopAutoCooldown();
  }
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

/**
 * Attempt to extract a discovery-level error code from an underlying
 * error. Some CdpInspectClient errors embed a discovery code (e.g.
 * "ECONNREFUSED", "DISCOVERY_TIMEOUT") that is useful for diagnostics.
 */
function extractDiscoveryCode(underlying: unknown): string | undefined {
  if (underlying == null) return undefined;
  if (typeof underlying === "object" && "code" in underlying) {
    const code = (underlying as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  if (underlying instanceof Error && "cause" in underlying) {
    return extractDiscoveryCode(underlying.cause);
  }
  return undefined;
}

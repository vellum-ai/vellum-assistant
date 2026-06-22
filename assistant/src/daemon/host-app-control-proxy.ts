/**
 * Host app-control proxy.
 *
 * Proxies app-control actions (start, observe, press, combo, type, click,
 * drag, stop) to the desktop client. Targets a specific application by
 * bundle ID or process name — distinct from the system-wide computer-use
 * proxy ({@link HostCuProxy}).
 *
 * Lifecycle (pending map, timeout, abort SSE, dispose, isAvailable) lives
 * in {@link HostProxyBase}; this class layers app-control-specific state
 * (PNG-hash loop guard) and the result-payload → ToolExecutionResult
 * translation on top.
 *
 * **Session lock.** Only one conversation may hold an active app-control
 * session at a time, and that session is bound to a specific target app
 * on a specific client.
 * The lock is module-level (`activeAppControlSession`) because the session
 * targets the user's actual desktop application, which is a host-wide
 * resource. It is acquired optimistically when `app_control_start` is
 * dispatched (storing `(conversationId, app, targetClientId)`) so that the synchronous
 * guard and the asynchronous host round-trip cannot race. A separate
 * `confirmedAppControlSession` tracks the last session the host reported
 * `running`; the rollback path on a failed `start` restores from the
 * current confirmed pointer (not from a per-call snapshot of a sibling
 * optimistic write), so two overlapping starts that both fail cannot
 * leave a phantom lock. Each session carries a monotonic `dispatchedAt`
 * counter so out-of-order `running` responses promote in dispatch order:
 * the latest-dispatched start that the host confirms becomes the
 * confirmed baseline, regardless of which response arrived last. The
 * lock is released outright when the owning proxy's `dispose()` fires.
 *
 * `app_control_start` is the only tool that can acquire the lock — the
 * user's medium-risk approval at start time is the consent boundary. All
 * other tools (observe / press / combo / sequence / type / click / drag)
 * require the calling conversation to own an active session targeting the
 * same `app` and client; otherwise the call is rejected before any host dispatch.
 * This prevents prompt-injected tool calls from sending raw input to
 * arbitrary apps without the user having approved control of that
 * specific app.
 *
 * **No step cap.** Unlike {@link HostCuProxy} which enforces a per-session
 * step ceiling via `loadConfig().maxStepsPerSession`, app-control sessions
 * are not capped. App-control flows are typically narrower (single-app,
 * shorter horizons) and the loop guard plus user oversight are the
 * intended safeguards.
 */

import { createHash } from "node:crypto";

import type { ContentBlock } from "../providers/types.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import {
  enforceSameActorOrErrorResult,
  pickSameUserAutoResolve,
} from "../runtime/auth/same-actor.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { HostProxyBase, HostProxyRequestError } from "./host-proxy-base.js";
import type {
  HostAppControlInput,
  HostAppControlResultPayload,
} from "./message-types/host-app-control.js";

const log = getLogger("host-app-control-proxy");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 60 * 1000;
// Threshold of 4 means the warning fires on the 5th identical observation:
// the first observation establishes the baseline (count = 0), each
// subsequent identical observation increments the counter, so count = 4 is
// reached on the 5th total observation.
const STUCK_REPEAT_THRESHOLD = 4;

// ---------------------------------------------------------------------------
// Module-level session lock
// ---------------------------------------------------------------------------

/**
 * Active app-control session: the conversation that owns the lock, the
 * `app` and client it was approved against. Set on a successful
 * `app_control_start`; cleared by the owning proxy's `dispose()`.
 */
export interface ActiveAppControlSession {
  conversationId: string;
  /**
   * The exact `app` string the user approved at start time (bundle ID or
   * process name — preserved as-is). Compared case-insensitively against
   * the `app` of subsequent non-start tool calls.
   */
  app: string;
  /**
   * The client selected for `app_control_start`. Undefined when the start
   * was untargeted; subsequent calls must match the same value.
   */
  targetClientId?: string;
  /**
   * Strictly monotonic counter assigned when the session is created (in
   * `request()` for a `start`). Used by {@link promoteStartIfCurrent} to
   * tell which of two confirmations from overlapping starts is newer when
   * host responses arrive out of order. Larger values are newer.
   */
  dispatchedAt: number;
}

/**
 * Monotonic counter that stamps each `start`'s {@link
 * ActiveAppControlSession.dispatchedAt}. Process-lifetime monotonic; the
 * absolute value is meaningless — only ordering matters.
 */
let nextDispatchedAt = 1;

/**
 * Currently active session, or `undefined` when no session is held. This
 * is the optimistic value: it is set the moment a `start` is dispatched
 * and only promoted to {@link confirmedAppControlSession} when the host
 * returns `running`.
 *
 * Exported for test inspection only. Production code paths must not read
 * or mutate this directly — use the proxy methods.
 */
let activeAppControlSession: ActiveAppControlSession | undefined;

/**
 * Last session whose `start` was confirmed by the host (`payload.state ===
 * "running"`). Used as the rollback baseline so a failed start never
 * restores a sibling in-flight optimistic write — only a session that was
 * actually running can re-emerge from a rollback.
 */
let confirmedAppControlSession: ActiveAppControlSession | undefined;

/** Test-only helper: read current (optimistic) session. */
export function _getActiveAppControlSession():
  | ActiveAppControlSession
  | undefined {
  return activeAppControlSession;
}

/** Test-only helper: read the last host-confirmed session. */
export function _getConfirmedAppControlSession():
  | ActiveAppControlSession
  | undefined {
  return confirmedAppControlSession;
}

/** Test-only helper: clear both session pointers between test cases. */
export function _resetActiveAppControlSession(): void {
  activeAppControlSession = undefined;
  confirmedAppControlSession = undefined;
}

/**
 * Test-only helper: prime both session pointers without a full `start`
 * round-trip. Useful for tests that exercise non-start tool paths and
 * don't need to verify the start flow itself.
 */
export function _setActiveAppControlSession(session: {
  conversationId: string;
  app: string;
  targetClientId?: string;
  dispatchedAt?: number;
}): void {
  const full: ActiveAppControlSession = {
    conversationId: session.conversationId,
    app: session.app,
    targetClientId: session.targetClientId,
    dispatchedAt: session.dispatchedAt ?? nextDispatchedAt++,
  };
  activeAppControlSession = full;
  confirmedAppControlSession = full;
}

/**
 * Validate a non-start tool call against the active session. Returns a
 * `ToolExecutionResult` (with `isError: true`) when the call should be
 * rejected; returns `null` when the call is authorized to dispatch.
 *
 * `app` matching is case-insensitive (macOS bundle IDs are
 * case-insensitive in practice) but strict on form: `"Safari"` and
 * `"com.apple.Safari"` do not match — the user approved a specific string
 * and substituting a different form requires a new approval.
 */
function checkNonStartAuthorization(
  input: HostAppControlInput,
  conversationId: string,
  targetClientId: string | undefined,
): ToolExecutionResult | null {
  if (activeAppControlSession == null) {
    return {
      content:
        "No app-control session is active. Call app_control_start to request " +
        "user approval to control the target app, then retry.",
      isError: true,
    };
  }
  if (activeAppControlSession.conversationId !== conversationId) {
    return {
      content:
        `Another conversation (${activeAppControlSession.conversationId}) currently ` +
        `holds the app-control session. Wait for it to finish, or call ` +
        `app_control_stop from that conversation first.`,
      isError: true,
    };
  }
  // `app` is required on every non-start variant of HostAppControlInput
  // except `stop`, and `stop` short-circuits in conversation-surfaces and
  // does not reach this method in production. A stop reaching here would
  // be a defensive bug — surface it explicitly rather than dispatch.
  const requestedApp = (input as { app?: unknown }).app;
  if (typeof requestedApp !== "string") {
    return {
      content:
        "Tool input missing required string 'app' field; cannot validate " +
        "against the active app-control session.",
      isError: true,
    };
  }
  if (
    requestedApp.toLowerCase() !== activeAppControlSession.app.toLowerCase()
  ) {
    return {
      content:
        `Active app-control session targets ${activeAppControlSession.app}; ` +
        `cannot send actions to ${requestedApp}. Call app_control_stop and ` +
        `app_control_start to switch apps.`,
      isError: true,
    };
  }
  if (activeAppControlSession.targetClientId !== targetClientId) {
    return {
      content:
        `Active app-control session targets client ` +
        `${activeAppControlSession.targetClientId ?? "<default>"}; cannot ` +
        `send actions to client ${targetClientId ?? "<default>"}. Call ` +
        `app_control_stop and app_control_start to switch clients.`,
      isError: true,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// HostAppControlProxy
// ---------------------------------------------------------------------------

export class HostAppControlProxy extends HostProxyBase<
  HostAppControlInput,
  HostAppControlResultPayload
> {
  /** Conversation that owns this proxy instance. Used by `dispose()` to release the session lock only when this proxy is the holder. */
  private readonly conversationId: string;

  /** sha256 hex of the most recent observation's `pngBase64`, or undefined. */
  private lastObservationHash?: string;

  /**
   * Number of consecutive observations whose PNG hash matched the previous
   * one. Reset to 0 when a different hash is observed. When this reaches
   * {@link STUCK_REPEAT_THRESHOLD}, results carry a `"stuck"` warning.
   */
  private observationHashRepeatCount = 0;

  constructor(conversationId: string) {
    super({
      capabilityName: "host_app_control",
      requestEventName: "host_app_control_request",
      cancelEventName: "host_app_control_cancel",
      resultPendingKind: "host_app_control",
      timeoutMs: REQUEST_TIMEOUT_MS,
      disposedMessage: "Host app-control proxy disposed",
    });
    this.conversationId = conversationId;
  }

  // ---------------------------------------------------------------------------
  // State accessors (testing / external inspection)
  // ---------------------------------------------------------------------------

  get observationRepeatCount(): number {
    return this.observationHashRepeatCount;
  }

  // ---------------------------------------------------------------------------
  // Public request entry point
  // ---------------------------------------------------------------------------

  /**
   * Dispatch an app-control tool call to the desktop client. Catches the
   * base's typed lifecycle errors (timeout/aborted/disposed) and returns
   * a `ToolExecutionResult` instead of letting them bubble.
   */
  async request(
    toolName: string,
    input: HostAppControlInput,
    conversationId: string,
    signal: AbortSignal,
    sourceActorPrincipalId?: string,
    targetClientId?: string,
  ): Promise<ToolExecutionResult> {
    if (signal.aborted) {
      return { content: "Aborted", isError: true };
    }

    // Resolve target client and enforce same-actor BEFORE acquiring the
    // session lock. This way early-exit errors don't need rollback, and
    // the resolved client id can be stored in the session.
    let resolvedTargetClientId = targetClientId;
    if (resolvedTargetClientId == null) {
      const resolved = pickSameUserAutoResolve({
        hub: assistantEventHub,
        capability: "host_app_control",
        sourceActorPrincipalId,
      });
      if (resolved.kind === "ambiguous") {
        return {
          content:
            "Multiple host_app_control clients are connected for this user. Specify target_client_id to disambiguate.",
          isError: true,
        };
      }
      if (resolved.kind === "match") {
        resolvedTargetClientId = resolved.clientId;
      } else if (
        assistantEventHub.listClientsByCapability("host_app_control").length > 0
      ) {
        return {
          content:
            "App control is not available for the current actor. Connect a host_app_control-capable client as the same user.",
          isError: true,
        };
      }
    }

    if (resolvedTargetClientId != null) {
      const rejection = enforceSameActorOrErrorResult({
        hub: assistantEventHub,
        sourceActorPrincipalId,
        targetClientId: resolvedTargetClientId,
        op: "host_app_control",
      });
      if (rejection) {
        return rejection;
      }
    }

    // Authorization gate. `start` acquires the session lock (the user's
    // medium-risk approval is the consent boundary); all other tools must
    // belong to the active session and target the same `app` and client.
    // Without this gate, prompt-injected calls would bypass the start-time
    // approval and send raw input to arbitrary apps or clients.
    let attemptedSession: ActiveAppControlSession | undefined;
    if (input.tool === "start") {
      if (
        activeAppControlSession != null &&
        activeAppControlSession.conversationId !== this.conversationId
      ) {
        return {
          content:
            `Another conversation (${activeAppControlSession.conversationId}) currently holds the ` +
            `app-control session. Wait for it to finish, or call app_control_stop ` +
            `from that conversation first.`,
          isError: true,
        };
      }
      // Acquire optimistically to close the TOCTOU window between this
      // synchronous guard and the asynchronous `dispatchRequest` below. Two
      // concurrent starts from different conversations would otherwise both
      // see `activeAppControlSession == null` and both pass the guard. The
      // lock is rolled back below if dispatch fails or the host returns a
      // non-running state — keyed on object identity so that a later
      // overlapping start that has already replaced our write is not
      // clobbered by a stale rollback.
      attemptedSession = {
        conversationId: this.conversationId,
        app: input.app,
        targetClientId: resolvedTargetClientId,
        dispatchedAt: nextDispatchedAt++,
      };
      activeAppControlSession = attemptedSession;
    } else {
      const sessionError = checkNonStartAuthorization(
        input,
        this.conversationId,
        resolvedTargetClientId,
      );
      if (sessionError != null) {
        return sessionError;
      }
    }

    try {
      const payload = await this.dispatchRequest(
        toolName,
        input,
        conversationId,
        signal,
        undefined,
        resolvedTargetClientId,
      );
      if (input.tool === "start") {
        if (payload.state === "running") {
          this.promoteStartIfCurrent(attemptedSession);
        } else {
          this.rollbackStartIfCurrent(attemptedSession);
        }
      }
      return this.handleSuccess(payload);
    } catch (err) {
      if (input.tool === "start") {
        this.rollbackStartIfCurrent(attemptedSession);
      }
      if (err instanceof HostProxyRequestError) {
        if (err.reason === "timeout") {
          log.warn({ toolName }, "Host app-control proxy request timed out");
          return {
            content:
              "Host app-control proxy timed out waiting for client response",
            isError: true,
          };
        }
        if (err.reason === "aborted") {
          return { content: "Aborted", isError: true };
        }
      }
      // `disposed` and any other unexpected errors propagate.
      throw err;
    }
  }

  /**
   * Roll back the optimistic overwrite performed by a `start` when the
   * dispatch fails or the host returns non-running. Keyed on the
   * `attempted` reference, not just `conversationId`, so that an
   * out-of-order failure does not clobber a newer overlapping start that
   * already replaced our write — e.g. start A → start B (pending) →
   * start C (success); when B later fails, the live session is C and the
   * identity check makes our rollback a no-op rather than restoring A.
   *
   * Restores from the *current* `confirmedAppControlSession`, not a
   * per-call snapshot of it. This matters when a late-arriving `running`
   * for an older overlapping start has updated `confirmedAppControlSession`
   * in the meantime: if A is dispatched, then C is dispatched (overwriting
   * active), then A returns `running` (confirming A), then C returns
   * non-running, the rollback must restore active to A — not undefined.
   */
  private rollbackStartIfCurrent(
    attempted: ActiveAppControlSession | undefined,
  ): void {
    if (attempted != null && activeAppControlSession === attempted) {
      activeAppControlSession = confirmedAppControlSession;
    }
  }

  /**
   * Promote this start's session to the confirmed pointer when the host
   * returns `running`. Two gates:
   *
   * 1. The live optimistic write must still belong to this conversation —
   *    if `dispose()` cleared the lock or another conversation acquired
   *    it, this confirmation must not resurrect a stale session.
   * 2. The confirming session must be at least as recent as the currently
   *    confirmed one, compared via {@link
   *    ActiveAppControlSession.dispatchedAt}. The dispatch counter is
   *    assigned synchronously in `request()`, so it captures dispatch
   *    order even when host responses arrive out of order. The latest
   *    dispatched start that confirms wins, which is the right baseline
   *    for the rollback path: if a newer start later fails, rollback
   *    restores the most recently confirmed session, not an older one.
   *
   * Also advance the active pointer when it is strictly older than the
   * newly-confirmed session. This handles the case where an even newer
   * optimistic write has already failed and rolled active back to the
   * previous confirmed session; without this, observe/actions for the
   * newly-confirmed session would target the older app. A newer
   * in-flight optimistic write (higher `dispatchedAt`) is preserved.
   */
  private promoteStartIfCurrent(
    attempted: ActiveAppControlSession | undefined,
  ): void {
    if (attempted == null) return;
    if (activeAppControlSession?.conversationId !== attempted.conversationId) {
      return;
    }
    if (
      confirmedAppControlSession != null &&
      attempted.dispatchedAt <= confirmedAppControlSession.dispatchedAt
    ) {
      return;
    }
    confirmedAppControlSession = attempted;
    if (activeAppControlSession.dispatchedAt < attempted.dispatchedAt) {
      activeAppControlSession = attempted;
    }
  }

  /**
   * Release both the optimistic and confirmed module-level session
   * pointers if this proxy is the current holder. Used by `dispose()` —
   * distinct from `rollbackStartIfCurrent` because dispose is keyed on
   * ownership (conversationId) rather than on a specific in-flight start.
   */
  private releaseSessionIfHeld(): void {
    if (activeAppControlSession?.conversationId === this.conversationId) {
      activeAppControlSession = undefined;
    }
    if (confirmedAppControlSession?.conversationId === this.conversationId) {
      confirmedAppControlSession = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Result handling
  // ---------------------------------------------------------------------------

  private handleSuccess(
    payload: HostAppControlResultPayload,
  ): ToolExecutionResult {
    // Update PNG-hash loop tracking only for the "running" state — other
    // states (missing/minimized) intentionally won't carry a
    // representative window screenshot, so they should not feed the guard.
    let stuck = false;
    if (payload.state === "running" && payload.pngBase64) {
      const hash = createHash("sha256").update(payload.pngBase64).digest("hex");
      if (hash === this.lastObservationHash) {
        this.observationHashRepeatCount++;
      } else {
        this.observationHashRepeatCount = 0;
      }
      this.lastObservationHash = hash;
      if (this.observationHashRepeatCount >= STUCK_REPEAT_THRESHOLD) {
        stuck = true;
      }
    }

    return this.formatResult(payload, stuck);
  }

  private formatResult(
    payload: HostAppControlResultPayload,
    stuck: boolean,
  ): ToolExecutionResult {
    const parts: string[] = [];

    if (stuck) {
      parts.push(
        `WARNING: ${this.observationHashRepeatCount} consecutive observations ` +
          `produced an identical screenshot — the app appears stuck. Try a ` +
          `different action or call app_control_stop and restart.`,
      );
      parts.push("");
    }

    parts.push(`State: ${payload.state}`);

    if (payload.windowBounds) {
      const { x, y, width, height } = payload.windowBounds;
      parts.push(`Window bounds: ${width}x${height} at (${x}, ${y})`);
    }

    if (payload.executionResult) {
      parts.push("");
      parts.push(payload.executionResult);
    }

    const isError = payload.executionError != null;
    const errorPrefix = isError
      ? `Action failed: ${payload.executionError}`
      : null;

    const baseContent = parts.join("\n").trim() || `State: ${payload.state}`;
    const content = errorPrefix
      ? `${errorPrefix}\n\n${baseContent}`
      : baseContent;

    const contentBlocks: ContentBlock[] = [];
    if (payload.pngBase64) {
      contentBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: payload.pngBase64,
        },
      });
    }

    return {
      content,
      isError,
      ...(contentBlocks.length > 0 ? { contentBlocks } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Reject pending requests via the base, then release the session lock
   * if this proxy is the holder. Idempotent: safe to call multiple times.
   */
  override dispose(): void {
    super.dispose();
    this.releaseSessionIfHeld();
  }
}

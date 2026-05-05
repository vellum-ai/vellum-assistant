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
 * session at a time, and that session is bound to a specific target app.
 * The lock is module-level (`activeAppControlSession`) because the session
 * targets the user's actual desktop application, which is a host-wide
 * resource. It is acquired on a successful `app_control_start` (storing
 * `(conversationId, app)`) and released when the owning proxy's
 * `dispose()` fires.
 *
 * `app_control_start` is the only tool that can acquire the lock — the
 * user's medium-risk approval at start time is the consent boundary. All
 * other tools (observe / press / combo / sequence / type / click / drag)
 * require the calling conversation to own an active session targeting the
 * same `app`; otherwise the call is rejected before any host dispatch.
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
 * Active app-control session: the conversation that owns the lock and the
 * `app` it was approved against. Set on a successful `app_control_start`;
 * cleared by the owning proxy's `dispose()`.
 */
export interface ActiveAppControlSession {
  conversationId: string;
  /**
   * The exact `app` string the user approved at start time (bundle ID or
   * process name — preserved as-is). Compared case-insensitively against
   * the `app` of subsequent non-start tool calls.
   */
  app: string;
}

/**
 * Currently active session, or `undefined` when no session is held.
 *
 * Exported for test inspection only. Production code paths must not read
 * or mutate this directly — use the proxy methods.
 */
let activeAppControlSession: ActiveAppControlSession | undefined;

/** Test-only helper: read current session. */
export function _getActiveAppControlSession():
  | ActiveAppControlSession
  | undefined {
  return activeAppControlSession;
}

/** Test-only helper: clear session between test cases. */
export function _resetActiveAppControlSession(): void {
  activeAppControlSession = undefined;
}

/**
 * Test-only helper: prime the active session without a full `start` round-trip.
 * Useful for tests that exercise non-start tool paths and don't need to
 * verify the start flow itself.
 */
export function _setActiveAppControlSession(
  session: ActiveAppControlSession,
): void {
  activeAppControlSession = session;
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
  const requestedApp = (input as { app?: string }).app;
  if (requestedApp == null) {
    return {
      content:
        "Tool input missing required 'app' field; cannot validate against " +
        "the active app-control session.",
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
  ): Promise<ToolExecutionResult> {
    if (signal.aborted) {
      return { content: "Aborted", isError: true };
    }

    // Authorization gate. `start` acquires the session lock (the user's
    // medium-risk approval is the consent boundary); all other tools must
    // belong to the active session and target the same `app`. Without this
    // gate, prompt-injected calls would bypass the start-time approval and
    // send raw input to arbitrary apps.
    if (input.tool === "start") {
      if (
        activeAppControlSession != null &&
        activeAppControlSession.conversationId !== conversationId
      ) {
        return {
          content:
            `Another conversation (${activeAppControlSession.conversationId}) currently holds the ` +
            `app-control session. Wait for it to finish, or call app_control_stop ` +
            `from that conversation first.`,
          isError: true,
        };
      }
    } else {
      const sessionError = checkNonStartAuthorization(input, conversationId);
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
      );
      return this.handleSuccess(input, payload);
    } catch (err) {
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

  // ---------------------------------------------------------------------------
  // Result handling
  // ---------------------------------------------------------------------------

  private handleSuccess(
    input: HostAppControlInput,
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

    // Store the exact `app` form for validation against subsequent
    // non-start tool calls.
    if (input.tool === "start" && payload.state === "running") {
      activeAppControlSession = {
        conversationId: this.conversationId,
        app: input.app,
      };
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
    if (activeAppControlSession?.conversationId === this.conversationId) {
      activeAppControlSession = undefined;
    }
  }
}

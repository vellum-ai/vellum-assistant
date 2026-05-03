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
 * **Singleton lock.** Only one conversation may hold an active app-control
 * session at a time. The lock is module-level (`activeAppControlConversationId`)
 * because a session targets the user's actual desktop application, which
 * is a host-wide resource. The lock is acquired on a successful
 * `app_control_start` and released when the owning proxy's `dispose()`
 * fires. A second conversation that calls `start` while the lock is held
 * receives an `isError: true` tool result naming the holding conversation.
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
// Tool name constants
// ---------------------------------------------------------------------------
//
// Kept here (rather than imported from PR 5's tool registrations) so the
// proxy is independently testable. PR 5 must use these same string values.

const TOOL_START = "app_control_start";

// ---------------------------------------------------------------------------
// Module-level singleton lock
// ---------------------------------------------------------------------------

/**
 * Conversation id that currently owns the active app-control session, or
 * `undefined` if no session is active. Set on a successful
 * `app_control_start`; cleared by the owning proxy's `dispose()`.
 *
 * Exported for test inspection only. Production code paths must not read
 * or mutate this directly — use the proxy methods.
 */
let activeAppControlConversationId: string | undefined;

/** Test-only helper: read current lock owner. */
export function _getActiveAppControlConversationId(): string | undefined {
  return activeAppControlConversationId;
}

/** Test-only helper: clear lock between test cases. */
export function _resetActiveAppControlConversationId(): void {
  activeAppControlConversationId = undefined;
}

// ---------------------------------------------------------------------------
// HostAppControlProxy
// ---------------------------------------------------------------------------

export class HostAppControlProxy extends HostProxyBase<
  HostAppControlInput,
  HostAppControlResultPayload
> {
  /** Conversation that owns this proxy instance. Used by `dispose()` to release the singleton lock only when this proxy is the holder. */
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

    // Singleton-lock guard for `start`. Other tools assume a session
    // already exists and are not gated here.
    if (toolName === TOOL_START) {
      if (
        activeAppControlConversationId != null &&
        activeAppControlConversationId !== conversationId
      ) {
        return {
          content:
            `Another conversation (${activeAppControlConversationId}) currently holds the ` +
            `app-control session. Wait for it to finish, or call app_control_stop ` +
            `from that conversation first.`,
          isError: true,
        };
      }
    }

    try {
      const payload = await this.dispatchRequest(
        toolName,
        input,
        conversationId,
        signal,
      );
      return this.handleSuccess(toolName, payload);
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
    toolName: string,
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

    // Acquire the singleton lock on a successful `start`.
    if (toolName === TOOL_START && payload.state === "running") {
      activeAppControlConversationId = this.conversationId;
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
   * Reject pending requests via the base, then release the singleton lock
   * if this proxy is the holder. Idempotent: safe to call multiple times.
   */
  override dispose(): void {
    super.dispose();
    if (activeAppControlConversationId === this.conversationId) {
      activeAppControlConversationId = undefined;
    }
  }
}

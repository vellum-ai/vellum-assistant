/**
 * Host computer-use proxy.
 *
 * Proxies computer-use actions to the desktop client when running as a
 * managed assistant, following the same request/resolve pattern as
 * HostBashProxy. Also owns CU-specific state tracking (step counting,
 * loop detection, observation formatting) for the unified agent loop.
 *
 * Unlike HostBashProxy/HostFileProxy/HostTransferProxy, this is NOT a
 * singleton — each conversation gets its own instance because CU state
 * (step count, AX tree history, loop detection) is per-conversation.
 *
 * RPC lifecycle (resolve/reject/timer/detachAbort) is stored in
 * pendingInteractions alongside routing metadata.
 */

import { v4 as uuid } from "uuid";

import { escapeAxTreeContent } from "../agent/loop.js";
import { loadConfig } from "../config/loader.js";
import type { ContentBlock } from "../providers/types.js";
import {
  assistantEventHub,
  broadcastMessage,
} from "../runtime/assistant-event-hub.js";
import { enforceSameActorOrErrorResult } from "../runtime/auth/same-actor.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("host-cu-proxy");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_SEC = 60;
const MAX_HISTORY_ENTRIES = 10;
const LOOP_DETECTION_WINDOW = 3;
const CONSECUTIVE_UNCHANGED_WARNING_THRESHOLD = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CuObservationResult {
  axTree?: string;
  axDiff?: string;
  secondaryWindows?: string;
  screenshot?: string; // base64 JPEG
  screenshotWidthPx?: number;
  screenshotHeightPx?: number;
  screenWidthPt?: number;
  screenHeightPt?: number;
  executionResult?: string;
  executionError?: string;
  userGuidance?: string;
}

export interface ActionRecord {
  step: number;
  toolName: string;
  input: Record<string, unknown>;
  reasoning?: string;
}

// ---------------------------------------------------------------------------
// HostCuProxy
// ---------------------------------------------------------------------------

export class HostCuProxy {
  // CU state tracking (per-conversation)
  private _stepCount = 0;
  private _maxSteps: number;
  private _previousAXTree: string | undefined;
  private _consecutiveUnchangedSteps = 0;
  private _actionHistory: ActionRecord[] = [];
  /** Request IDs owned by this instance — used to scope dispose(). */
  private _ownedRequests = new Set<string>();

  constructor(maxSteps = loadConfig().maxStepsPerSession) {
    this._maxSteps = maxSteps;
  }

  // ---------------------------------------------------------------------------
  // CU state accessors (for testing / external inspection)
  // ---------------------------------------------------------------------------

  get stepCount(): number {
    return this._stepCount;
  }

  get maxSteps(): number {
    return this._maxSteps;
  }

  get previousAXTree(): string | undefined {
    return this._previousAXTree;
  }

  get consecutiveUnchangedSteps(): number {
    return this._consecutiveUnchangedSteps;
  }

  get actionHistory(): readonly ActionRecord[] {
    return this._actionHistory;
  }

  // ---------------------------------------------------------------------------
  // Availability
  // ---------------------------------------------------------------------------

  /**
   * Whether a client with `host_cu` capability is connected.
   */
  isAvailable(): boolean {
    return assistantEventHub.getMostRecentClientByCapability("host_cu") != null;
  }

  // ---------------------------------------------------------------------------
  // Request / resolve lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Send a CU request to the connected desktop client.
   *
   * When `targetClientId` is supplied, the proxy validates that the target
   * exists and advertises the `host_cu` capability, mirroring HostFileProxy's
   * resolver-side checks so that the proxy is safe to call as a standalone
   * API. It additionally enforces that the caller (`sourceActorPrincipalId`)
   * and the target client share the same actor principal — cross-user
   * targeted dispatch is rejected.
   */
  request(
    toolName: string,
    input: Record<string, unknown>,
    conversationId: string,
    stepNumber: number,
    reasoning?: string,
    signal?: AbortSignal,
    targetClientId?: string,
    sourceActorPrincipalId?: string,
  ): Promise<ToolExecutionResult> {
    if (signal?.aborted) {
      return Promise.resolve({
        content: "Aborted",
        isError: true,
      });
    }

    if (this._stepCount > this._maxSteps) {
      return Promise.resolve({
        content: `Step limit (${this._maxSteps}) exceeded. Call computer_use_done to finish.`,
        isError: true,
      });
    }

    // Existence + capability validation for explicit targets. Mirrors
    // HostFileProxy's resolver-side guard so that the proxy is safe even
    // when called outside the conversation-surfaces dispatch (which has
    // its own validation layer).
    if (targetClientId != null) {
      const client = assistantEventHub.getClientById(targetClientId);
      if (!client) {
        return Promise.resolve({
          content: `No connected client with id '${targetClientId}' supports host_cu. Run \`assistant clients list --capability host_cu\` to see available clients.`,
          isError: true,
        });
      }
      if (!client.capabilities.includes("host_cu")) {
        return Promise.resolve({
          content: `Client '${targetClientId}' does not support host_cu. Run \`assistant clients list --capability host_cu\` to see available clients.`,
          isError: true,
        });
      }

      // Same-user enforcement: targeted CU dispatch must be owned by the
      // same actor on both sides. This is the authoritative gate — the
      // dispatch layer (conversation-surfaces.ts) skips its own check
      // and relies on the proxy.
      const rejection = enforceSameActorOrErrorResult({
        hub: assistantEventHub,
        sourceActorPrincipalId,
        targetClientId,
        op: "host_cu",
      });
      if (rejection) return Promise.resolve(rejection);
    }

    const requestId = uuid();

    return new Promise<ToolExecutionResult>((resolve, reject) => {
      let detachAbort: () => void = () => {};

      const timer = setTimeout(() => {
        this._ownedRequests.delete(requestId);
        pendingInteractions.resolve(requestId);
        log.warn({ requestId, toolName }, "Host CU proxy request timed out");
        resolve({
          content: "Host CU proxy timed out waiting for client response",
          isError: true,
        });
      }, REQUEST_TIMEOUT_SEC * 1000);

      if (signal) {
        const onAbort = () => {
          if (pendingInteractions.get(requestId)) {
            this._ownedRequests.delete(requestId);
            pendingInteractions.resolve(requestId);
            try {
              broadcastMessage(
                {
                  type: "host_cu_cancel",
                  requestId,
                  conversationId,
                  ...(targetClientId != null ? { targetClientId } : {}),
                },
                conversationId,
                { targetClientId },
              );
            } catch {
              // Best-effort cancel notification
            }
            resolve({ content: "Aborted", isError: true });
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }

      this._ownedRequests.add(requestId);

      pendingInteractions.register(requestId, {
        conversationId,
        kind: "host_cu",
        targetClientId,
        targetActorPrincipalId:
          targetClientId != null
            ? assistantEventHub.getActorPrincipalIdForClient(targetClientId)
            : undefined,
        rpcResolve: resolve as (v: unknown) => void,
        rpcReject: reject,
        timer,
        detachAbort,
      });

      try {
        broadcastMessage(
          {
            type: "host_cu_request",
            requestId,
            conversationId,
            toolName,
            input,
            stepNumber,
            reasoning,
            // Include in body so receiving client can verify targeted endpoint.
            ...(targetClientId != null ? { targetClientId } : {}),
          },
          conversationId,
          { targetClientId },
        );
      } catch (err) {
        this._ownedRequests.delete(requestId);
        pendingInteractions.resolve(requestId);
        log.warn({ requestId, toolName, err }, "Host CU proxy send failed");
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Process a CU observation from the client and resolve the RPC.
   * Updates CU state (step tracking, AX tree history) and formats
   * the observation into a ToolExecutionResult.
   */
  processObservation(
    requestId: string,
    observation: CuObservationResult,
  ): ToolExecutionResult | undefined {
    this._ownedRequests.delete(requestId);
    const interaction = pendingInteractions.resolve(requestId);
    if (!interaction?.rpcResolve) {
      log.warn({ requestId }, "No pending host CU request for response");
      return undefined;
    }

    const prevAXTree = this._previousAXTree;
    this.updateStateFromObservation(observation);
    const result = this.formatObservation(observation, prevAXTree);
    interaction.rpcResolve(result);
    return result;
  }

  // ---------------------------------------------------------------------------
  // CU state management
  // ---------------------------------------------------------------------------

  /**
   * Increment step count and record an action. Call this before sending
   * each non-terminal tool request.
   */
  recordAction(
    toolName: string,
    input: Record<string, unknown>,
    reasoning?: string,
  ): void {
    this._stepCount++;
    this._actionHistory.push({
      step: this._stepCount,
      toolName,
      input,
      reasoning,
    });
    if (this._actionHistory.length > MAX_HISTORY_ENTRIES) {
      this._actionHistory = this._actionHistory.slice(-MAX_HISTORY_ENTRIES);
    }
  }

  /** Reset all CU state. Called on terminal tools (computer_use_done, etc.). */
  reset(): void {
    this._stepCount = 0;
    this._previousAXTree = undefined;
    this._consecutiveUnchangedSteps = 0;
    this._actionHistory = [];
  }

  // ---------------------------------------------------------------------------
  // Observation formatting
  // ---------------------------------------------------------------------------

  /**
   * Formats a CU observation into a ToolExecutionResult with text content
   * (AX tree wrapped in markers, diff, warnings) and optional screenshot
   * as an image content block.
   */
  formatObservation(
    obs: CuObservationResult,
    previousAXTree?: string,
  ): ToolExecutionResult {
    const prevTree = previousAXTree;
    const parts: string[] = [];

    if (obs.userGuidance) {
      parts.push(`USER GUIDANCE: ${obs.userGuidance}`);
      parts.push("");
    }

    if (obs.executionResult) {
      parts.push(obs.executionResult);
      parts.push("");
    }

    if (obs.axDiff) {
      parts.push(obs.axDiff);
      parts.push("");
    } else if (prevTree != null && obs.axTree != null) {
      const lastAction =
        this._actionHistory.length > 0
          ? this._actionHistory[this._actionHistory.length - 1]
          : undefined;
      const isWaitAction = lastAction?.toolName === "computer_use_wait";

      if (!isWaitAction) {
        if (
          this._consecutiveUnchangedSteps >=
          CONSECUTIVE_UNCHANGED_WARNING_THRESHOLD
        ) {
          parts.push(
            `WARNING: ${this._consecutiveUnchangedSteps} consecutive actions had NO VISIBLE EFFECT on the UI. You MUST try a completely different approach.`,
          );
        } else {
          parts.push(
            "Your last action had NO VISIBLE EFFECT on the UI. Try something different.",
          );
        }
        parts.push("");
      }
    }

    if (this._actionHistory.length >= LOOP_DETECTION_WINDOW) {
      const recent = this._actionHistory.slice(-LOOP_DETECTION_WINDOW);
      const allIdentical = recent.every(
        (r) =>
          r.toolName === recent[0].toolName &&
          JSON.stringify(r.input) === JSON.stringify(recent[0].input),
      );
      if (allIdentical) {
        parts.push(
          `WARNING: You've repeated the same action (${recent[0].toolName}) ${LOOP_DETECTION_WINDOW} times. Try something different.`,
        );
        parts.push("");
      }
    }

    if (obs.axTree) {
      parts.push("<ax-tree>");
      parts.push("CURRENT SCREEN STATE:");
      parts.push(escapeAxTreeContent(obs.axTree));
      parts.push("</ax-tree>");
    }

    if (obs.secondaryWindows) {
      parts.push("");
      parts.push(obs.secondaryWindows);
      parts.push("");
      parts.push(
        "Note: The element [ID]s above are from other windows — you can reference them for context but can only interact with the focused window's elements.",
      );
    }

    const screenshotMeta = this.formatScreenshotMetadata(obs);
    if (screenshotMeta.length > 0) {
      parts.push("");
      parts.push(...screenshotMeta);
    }

    const content = parts.join("\n").trim() || "Action executed";

    const contentBlocks: ContentBlock[] = [];
    if (obs.screenshot) {
      contentBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: obs.screenshot,
        },
      });
    }

    const isError = obs.executionError != null;

    return {
      content: isError
        ? `Action failed: ${obs.executionError}\n\n${content}`
        : content,
      isError,
      ...(contentBlocks.length > 0 ? { contentBlocks } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Dispose
  // ---------------------------------------------------------------------------

  dispose(): void {
    for (const requestId of this._ownedRequests) {
      const entry = pendingInteractions.resolve(requestId);
      if (!entry) continue;
      try {
        broadcastMessage(
          {
            type: "host_cu_cancel",
            requestId,
            conversationId: entry.conversationId,
            ...(entry.targetClientId != null
              ? { targetClientId: entry.targetClientId }
              : {}),
          },
          entry.conversationId,
          { targetClientId: entry.targetClientId as string | undefined },
        );
      } catch {
        // Best-effort cancel notification
      }
      entry.rpcReject?.(
        new AssistantError("Host CU proxy disposed", ErrorCode.INTERNAL_ERROR),
      );
    }
    this._ownedRequests.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private updateStateFromObservation(obs: CuObservationResult): void {
    if (this._stepCount > 0) {
      if (
        obs.axDiff == null &&
        this._previousAXTree != null &&
        obs.axTree != null
      ) {
        this._consecutiveUnchangedSteps++;
      } else if (obs.axDiff != null) {
        this._consecutiveUnchangedSteps = 0;
      }
    }

    if (obs.axTree != null) {
      this._previousAXTree = obs.axTree;
    }
  }

  private formatScreenshotMetadata(obs: CuObservationResult): string[] {
    if (!obs.screenshot) return [];

    const lines: string[] = [];
    if (obs.screenshotWidthPx != null && obs.screenshotHeightPx != null) {
      lines.push(
        `Screenshot metadata: ${obs.screenshotWidthPx}x${obs.screenshotHeightPx} px`,
      );
    }
    if (obs.screenWidthPt != null && obs.screenHeightPt != null) {
      lines.push(
        `Screen metadata: ${obs.screenWidthPt}x${obs.screenHeightPt} pt`,
      );
    }
    return lines;
  }
}

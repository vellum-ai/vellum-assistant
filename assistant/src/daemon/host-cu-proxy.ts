/**
 * Host computer-use proxy.
 *
 * Proxies computer-use actions to the desktop client when running as a
 * managed assistant, following the same request/resolve pattern as
 * HostBashProxy. Also owns CU-specific state tracking (step counting,
 * loop detection, observation formatting) for the unified agent loop.
 */

import { v4 as uuid } from "uuid";

import { escapeAxTreeContent } from "../agent/loop.js";
import { loadConfig } from "../config/loader.js";
import type { ContentBlock } from "../providers/types.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import type { ServerMessage } from "./message-protocol.js";

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

interface PendingRequest {
  resolve: (result: ToolExecutionResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// HostCuProxy
// ---------------------------------------------------------------------------

export class HostCuProxy {
  private pending = new Map<string, PendingRequest>();
  private sendToClient: (msg: ServerMessage) => void;
  private onInternalResolve?: (requestId: string) => void;
  private clientConnected = false;

  // CU state tracking (per-conversation)
  private _stepCount = 0;
  private _maxSteps: number;
  private _previousAXTree: string | undefined;
  private _consecutiveUnchangedSteps = 0;
  private _actionHistory: ActionRecord[] = [];

  constructor(
    sendToClient: (msg: ServerMessage) => void,
    onInternalResolve?: (requestId: string) => void,
    maxSteps = loadConfig().maxStepsPerSession,
  ) {
    this.sendToClient = sendToClient;
    this.onInternalResolve = onInternalResolve;
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
  // Sender management
  // ---------------------------------------------------------------------------

  updateSender(
    sendToClient: (msg: ServerMessage) => void,
    clientConnected: boolean,
  ): void {
    this.sendToClient = sendToClient;
    this.clientConnected = clientConnected;
  }

  // ---------------------------------------------------------------------------
  // Request / resolve lifecycle
  // ---------------------------------------------------------------------------

  request(
    toolName: string,
    input: Record<string, unknown>,
    conversationId: string,
    stepNumber: number,
    reasoning?: string,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (signal?.aborted) {
      return Promise.resolve({
        content: "Aborted",
        isError: true,
      });
    }

    // Enforce step limit before sending to client
    if (this._stepCount > this._maxSteps) {
      return Promise.resolve({
        content: `Step limit (${this._maxSteps}) exceeded. Call computer_use_done to finish.`,
        isError: true,
      });
    }

    const requestId = uuid();

    return new Promise<ToolExecutionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.onInternalResolve?.(requestId);
        log.warn({ requestId, toolName }, "Host CU proxy request timed out");
        resolve({
          content: "Host CU proxy timed out waiting for client response",
          isError: true,
        });
      }, REQUEST_TIMEOUT_SEC * 1000);

      this.pending.set(requestId, { resolve, reject, timer });

      if (signal) {
        const onAbort = () => {
          if (this.pending.has(requestId)) {
            clearTimeout(timer);
            this.pending.delete(requestId);
            this.onInternalResolve?.(requestId);
            this.sendToClient({
              type: "host_cu_cancel",
              requestId,
            } as ServerMessage);
            resolve({ content: "Aborted", isError: true });
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.sendToClient({
        type: "host_cu_request",
        requestId,
        conversationId,
        toolName,
        input,
        stepNumber,
        reasoning,
      } as ServerMessage);
    });
  }

  resolve(requestId: string, observation: CuObservationResult): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      log.warn({ requestId }, "No pending host CU request for response");
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(requestId);

    // Capture pre-update state so formatObservation sees the correct previous AX tree
    const prevAXTree = this._previousAXTree;

    // Update CU state from observation
    this.updateStateFromObservation(observation);

    const result = this.formatObservation(observation, prevAXTree);
    entry.resolve(result);
  }

  hasPendingRequest(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  isAvailable(): boolean {
    return this.clientConnected;
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
    // Keep history bounded
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

    // Surface user guidance prominently so the model sees it first
    if (obs.userGuidance) {
      parts.push(`USER GUIDANCE: ${obs.userGuidance}`);
      parts.push("");
    }

    if (obs.executionResult) {
      parts.push(obs.executionResult);
      parts.push("");
    }

    // AX tree diff / unchanged warning
    if (obs.axDiff) {
      parts.push(obs.axDiff);
      parts.push("");
    } else if (prevTree != null && obs.axTree != null) {
      // Skip unchanged warning after wait actions — they intentionally yield no immediate change
      const lastAction =
        this._actionHistory.length > 0
          ? this._actionHistory[this._actionHistory.length - 1]
          : undefined;
      const isWaitAction = lastAction?.toolName === "computer_use_wait";

      if (!isWaitAction) {
        // No diff means the screen didn't change
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

    // Loop detection: identical actions repeated
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

    // Current screen state wrapped in markers for history compaction
    if (obs.axTree) {
      parts.push("<ax-tree>");
      parts.push("CURRENT SCREEN STATE:");
      parts.push(escapeAxTreeContent(obs.axTree));
      parts.push("</ax-tree>");
    }

    // Secondary windows for cross-app awareness
    if (obs.secondaryWindows) {
      parts.push("");
      parts.push(obs.secondaryWindows);
      parts.push("");
      parts.push(
        "Note: The element [ID]s above are from other windows — you can reference them for context but can only interact with the focused window's elements.",
      );
    }

    // Screenshot metadata
    const screenshotMeta = this.formatScreenshotMetadata(obs);
    if (screenshotMeta.length > 0) {
      parts.push("");
      parts.push(...screenshotMeta);
    }

    const content = parts.join("\n").trim() || "Action executed";

    // Build content blocks for screenshot
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
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.onInternalResolve?.(requestId);
      this.sendToClient({ type: "host_cu_cancel", requestId } as ServerMessage);
      entry.reject(
        new AssistantError("Host CU proxy disposed", ErrorCode.INTERNAL_ERROR),
      );
    }
    this.pending.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Update consecutive-unchanged tracking from an incoming observation. */
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

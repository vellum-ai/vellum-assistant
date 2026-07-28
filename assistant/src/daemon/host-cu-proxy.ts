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

import { loadConfig } from "../config/loader.js";
import { escapeAxTreeContent } from "../context/outbound-sanitize.js";
import type { ContentBlock } from "../providers/types.js";
import {
  assistantEventHub,
  broadcastMessage,
} from "../runtime/assistant-event-hub.js";
import {
  ambiguousSameUserError,
  enforceSameActorOrErrorResult,
  pickSameUserAutoResolve,
} from "../runtime/auth/same-actor.js";
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

// computer_use_key combos that change only selection/cursor/clipboard state.
// The AX tree models none of these, so they always produce an empty diff —
// exempt them from the "NO VISIBLE EFFECT" signal (mirrors computer_use_wait).
// Stored in canonical form (see canonicalizeKeyCombo): modifier aliases
// normalized and ordered, so `cmd + a`, `command+a`, `alt+tab`, `tab+shift`
// all match.
const NO_AX_DIFF_KEY_COMBOS = new Set([
  "cmd+a",
  "cmd+c",
  "up",
  "down",
  "left",
  "right",
  "shift+tab",
  "option+tab",
]);

// Modifier aliases mirror the mac helper's ActionExecutor.pressKey so the
// exemption check matches exactly what the helper will execute.
const KEY_MODIFIER_ALIASES: Record<string, string> = {
  cmd: "cmd",
  command: "cmd",
  option: "option",
  alt: "option",
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
};
const KEY_MODIFIER_ORDER = ["cmd", "ctrl", "option", "shift"];

/**
 * Normalize a key combo the way the mac helper does (lowercase, split on `+`,
 * trim, alias modifiers) into a canonical `mods…+base` string with modifiers
 * in a fixed order — so order/alias/whitespace variants compare equal.
 */
function canonicalizeKeyCombo(key: string): string {
  const mods = new Set<string>();
  let base = "";
  for (const raw of key.toLowerCase().split("+")) {
    const part = raw.trim();
    if (part.length === 0) continue;
    const mod = KEY_MODIFIER_ALIASES[part];
    if (mod) mods.add(mod);
    else base = part; // last non-modifier wins, matching the executor
  }
  return [...KEY_MODIFIER_ORDER.filter((m) => mods.has(m)), base]
    .filter((s) => s.length > 0)
    .join("+");
}

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

/**
 * True when `action` is a computer_use_key press whose key only mutates
 * selection/cursor/clipboard state — changes the AX tree cannot represent, so
 * an empty diff is expected rather than a sign the action did nothing.
 */
function isNoDiffKeyAction(action: ActionRecord | undefined): boolean {
  if (action?.toolName !== "computer_use_key") return false;
  const key = action.input.key;
  return (
    typeof key === "string" &&
    NO_AX_DIFF_KEY_COMBOS.has(canonicalizeKeyCombo(key))
  );
}

/**
 * Canonical signature for loop detection. Key presses collapse equivalent
 * spellings (`cmd+a`, `command+a`, `cmd + a`) of the same combo so a stuck
 * session retrying it with alias/whitespace variants is still caught —
 * important now that exempt keys no longer emit no-effect warnings. Only the
 * `key` value is normalized; all other input fields (e.g. the routing
 * `target_client_id`) are preserved, so the same combo sent to different
 * desktop clients is not mistaken for a repeat.
 */
function actionSignature(record: ActionRecord): string {
  if (
    record.toolName === "computer_use_key" &&
    typeof record.input.key === "string"
  ) {
    const normalizedInput = {
      ...record.input,
      key: canonicalizeKeyCombo(record.input.key),
    };
    return `computer_use_key:${JSON.stringify(normalizedInput)}`;
  }
  return `${record.toolName}:${JSON.stringify(record.input)}`;
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

    let resolvedTargetClientId = targetClientId;
    if (resolvedTargetClientId == null) {
      const resolved = pickSameUserAutoResolve({
        hub: assistantEventHub,
        capability: "host_cu",
        sourceActorPrincipalId,
      });
      if (resolved.kind === "ambiguous") {
        return Promise.resolve(ambiguousSameUserError("host_cu"));
      }
      if (resolved.kind === "match") {
        resolvedTargetClientId = resolved.clientId;
      } else if (
        assistantEventHub.listClientsByCapability("host_cu").length > 0
      ) {
        return Promise.resolve({
          content:
            "Computer use is not available for the current actor. Connect a host_cu-capable client as the same user.",
          isError: true,
        });
      }
    }

    if (resolvedTargetClientId != null) {
      const client = assistantEventHub.getClientById(resolvedTargetClientId);
      if (!client) {
        return Promise.resolve({
          content: `No connected client with id '${resolvedTargetClientId}' supports host_cu. Run \`assistant clients list --capability host_cu\` to see available clients.`,
          isError: true,
        });
      }
      if (!client.capabilities.includes("host_cu")) {
        return Promise.resolve({
          content: `Client '${resolvedTargetClientId}' does not support host_cu. Run \`assistant clients list --capability host_cu\` to see available clients.`,
          isError: true,
        });
      }

      const rejection = enforceSameActorOrErrorResult({
        hub: assistantEventHub,
        sourceActorPrincipalId,
        targetClientId: resolvedTargetClientId,
        op: "host_cu",
      });
      if (rejection) return Promise.resolve(rejection);
    }

    const requestId = uuid();

    return new Promise<ToolExecutionResult>((resolve, reject) => {
      let detachAbort: () => void = () => {};

      const timer = setTimeout(() => {
        this._ownedRequests.delete(requestId);
        pendingInteractions.resolve(requestId, "cancelled");
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
            pendingInteractions.resolve(requestId, "cancelled");
            try {
              broadcastMessage(
                {
                  type: "host_cu_cancel",
                  requestId,
                  conversationId,
                  ...(resolvedTargetClientId != null
                    ? { targetClientId: resolvedTargetClientId }
                    : {}),
                },
                conversationId,
                { targetClientId: resolvedTargetClientId },
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
        targetClientId: resolvedTargetClientId,
        targetActorPrincipalId:
          resolvedTargetClientId != null
            ? assistantEventHub.getActorPrincipalIdForClient(
                resolvedTargetClientId,
              )
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
            ...(resolvedTargetClientId != null
              ? { targetClientId: resolvedTargetClientId }
              : {}),
          },
          conversationId,
          { targetClientId: resolvedTargetClientId },
        );
      } catch (err) {
        this._ownedRequests.delete(requestId);
        pendingInteractions.resolve(requestId, "cancelled");
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
    const interaction = pendingInteractions.resolve(requestId, "answered");
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
      const isNoDiffKey = isNoDiffKeyAction(lastAction);

      if (!isWaitAction && !isNoDiffKey) {
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
      const firstSignature = actionSignature(recent[0]);
      const allIdentical = recent.every(
        (r) => actionSignature(r) === firstSignature,
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
      const entry = pendingInteractions.resolve(requestId, "cancelled");
      if (!entry) continue;
      const { conversationId } = entry;
      try {
        if (conversationId !== undefined) {
          broadcastMessage(
            {
              type: "host_cu_cancel",
              requestId,
              conversationId,
              ...(entry.targetClientId != null
                ? { targetClientId: entry.targetClientId }
                : {}),
            },
            conversationId,
            { targetClientId: entry.targetClientId as string | undefined },
          );
        }
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
      const lastAction =
        this._actionHistory.length > 0
          ? this._actionHistory[this._actionHistory.length - 1]
          : undefined;
      if (obs.axDiff != null || isNoDiffKeyAction(lastAction)) {
        // A real diff, or an exempt key whose effect is invisible by design,
        // breaks the no-effect streak — clear it rather than preserving a
        // stale count so an intervening cmd+a can't bridge two no-op actions
        // into a false "consecutive" escalation.
        this._consecutiveUnchangedSteps = 0;
      } else if (this._previousAXTree != null && obs.axTree != null) {
        this._consecutiveUnchangedSteps++;
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

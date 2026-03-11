/**
 * Computer-use session orchestrator.
 *
 * Manages the observation -> infer -> action loop for computer-use tasks,
 * bridging the macOS client (which captures screen state and executes actions)
 * with the AgentLoop (which runs inference via the Anthropic API with CU tools).
 */

import { v4 as uuid } from "uuid";

import { AgentLoop } from "../agent/loop.js";
import { getConfig } from "../config/loader.js";
import { PermissionPrompter } from "../permissions/prompter.js";
import { SecretPrompter } from "../permissions/secret-prompter.js";
import type { UserDecision } from "../permissions/types.js";
import { buildComputerUseSystemPrompt } from "../prompts/computer-use-prompt.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ToolDefinition,
} from "../providers/types.js";
import { allComputerUseTools } from "../tools/computer-use/definitions.js";
import { ToolExecutor } from "../tools/executor.js";
import { getTool, registerSkillTools } from "../tools/registry.js";
import {
  injectReasonField,
  REASON_SKIP_SET,
} from "../tools/schema-transforms.js";
import type { Tool, ToolExecutionResult } from "../tools/types.js";
import { allUiSurfaceTools } from "../tools/ui-surface/definitions.js";
import { getLogger } from "../util/logger.js";
import { getSandboxWorkingDir } from "../util/platform.js";
import type {
  CuObservation,
  ServerMessage,
  SurfaceData,
  SurfaceType,
  UiSurfaceShow,
} from "./message-protocol.js";
import { INTERACTIVE_SURFACE_TYPES } from "./message-protocol.js";
import {
  projectSkillTools,
  resetSkillToolProjection,
  type SkillProjectionCache,
} from "./session-skill-tools.js";

const log = getLogger("computer-use-session");

const MAX_STEPS = 50;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_HISTORY_ENTRIES = 10;
const LOOP_DETECTION_WINDOW = 3;
const CONSECUTIVE_UNCHANGED_WARNING_THRESHOLD = 2;

/** Number of most-recent AX tree snapshots to keep in conversation history. */
const MAX_AX_TREES_IN_HISTORY = 2;

/** Regex that matches the `<ax-tree>…</ax-tree>` markers injected by buildObservationResultContent. */
const AX_TREE_PATTERN = /<ax-tree>[\s\S]*?<\/ax-tree>/g;
const AX_TREE_PLACEHOLDER = "<ax_tree_omitted />";

type SessionState =
  | "idle"
  | "awaiting_observation"
  | "inferring"
  | "complete"
  | "error";

interface ActionRecord {
  step: number;
  toolName: string;
  input: Record<string, unknown>;
  reasoning?: string;
  result?: string;
}

export class ComputerUseSession {
  private readonly sessionId: string;
  private readonly task: string;
  private readonly screenWidth: number;
  private readonly screenHeight: number;
  private readonly provider: Provider;
  private sendToClient: (msg: ServerMessage) => void;
  private readonly interactionType: "computer_use" | "text_qa";
  private readonly onTerminal?: (sessionId: string) => void;
  private readonly preactivatedSkillIds: string[];
  private readonly skillProjectionState = new Map<string, string>();
  private readonly skillProjectionCache: SkillProjectionCache = {};

  private state: SessionState = "idle";
  private stepCount = 0;
  private actionHistory: ActionRecord[] = [];
  private previousAXTree: string | undefined;
  private consecutiveUnchangedSteps = 0;
  private abortController: AbortController | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;

  private pendingObservation: {
    resolve: (result: ToolExecutionResult) => void;
  } | null = null;

  private pendingSurfaceActions = new Map<
    string,
    {
      resolve: (result: ToolExecutionResult) => void;
    }
  >();
  /** @internal */ surfaceState = new Map<
    string,
    { surfaceType: SurfaceType; data: SurfaceData; title?: string }
  >();
  private terminalNotified = false;
  private prompter: PermissionPrompter | null = null;

  // Tracks the agent loop promise so callers can await session completion
  private loopPromise: Promise<void> | null = null;

  constructor(
    sessionId: string,
    task: string,
    screenWidth: number,
    screenHeight: number,
    provider: Provider,
    sendToClient: (msg: ServerMessage) => void,
    interactionType?: "computer_use" | "text_qa",
    onTerminal?: (sessionId: string) => void,
    preactivatedSkillIds?: string[],
  ) {
    this.sessionId = sessionId;
    this.task = task;
    this.screenWidth = screenWidth;
    this.screenHeight = screenHeight;
    this.provider = provider;
    this.sendToClient = sendToClient;
    this.interactionType = interactionType ?? "computer_use";
    this.onTerminal = onTerminal;
    this.preactivatedSkillIds = preactivatedSkillIds ?? ["computer-use"];
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async handleObservation(obs: CuObservation): Promise<void> {
    if (this.state === "complete" || this.state === "error") {
      log.warn(
        { sessionId: this.sessionId, state: this.state },
        "Observation received after session ended",
      );
      return;
    }

    // Track consecutive unchanged steps
    const hadPreviousAXTree = this.previousAXTree != null;
    if (this.stepCount > 0) {
      if (obs.axDiff == null && hadPreviousAXTree && obs.axTree != null) {
        this.consecutiveUnchangedSteps++;
      } else if (obs.axDiff != null) {
        this.consecutiveUnchangedSteps = 0;
      }
    }

    // Capture previous AX tree for next turn
    if (obs.axTree != null) {
      this.previousAXTree = obs.axTree;
    }

    if (this.state === "awaiting_observation" && this.pendingObservation) {
      // Resolve the pending proxy tool result with updated screen context
      const content = this.buildObservationResultContent(
        obs,
        hadPreviousAXTree,
      );
      const result: ToolExecutionResult = obs.executionError
        ? {
            content: `Action failed: ${obs.executionError}\n\n${content}`,
            isError: true,
          }
        : { content, isError: false };
      this.state = "inferring";
      this.pendingObservation.resolve(result);
      this.pendingObservation = null;
      // The agent loop continues automatically after resolution
      return;
    }

    // First observation — start the agent loop
    this.state = "inferring";
    this.abortController = new AbortController();

    // Safety net: abort the session if it runs longer than SESSION_TIMEOUT_MS
    this.sessionTimer = setTimeout(() => {
      log.warn(
        { sessionId: this.sessionId, timeoutMs: SESSION_TIMEOUT_MS },
        "Session timeout reached, aborting",
      );
      this.abort();
    }, SESSION_TIMEOUT_MS);

    const messages = this.buildMessages(obs, hadPreviousAXTree);
    this.loopPromise = this.runAgentLoop(messages).catch((err) => {
      // Catches errors from setup code (e.g. skill projection failures) that
      // occur before runAgentLoop's internal try-catch takes over.
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err, sessionId: this.sessionId },
        "Agent loop startup failed",
      );
      if (this.sessionTimer) {
        clearTimeout(this.sessionTimer);
        this.sessionTimer = null;
      }
      if (this.state !== "complete" && this.state !== "error") {
        this.state = "error";
        this.sendToClient({
          type: "cu_error",
          sessionId: this.sessionId,
          message,
        });
        this.notifyTerminal();
      }
    });

    await this.loopPromise;
  }

  abort(): void {
    if (this.state === "complete" || this.state === "error") return;

    log.info({ sessionId: this.sessionId }, "Aborting computer-use session");
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
    this.abortController?.abort();

    // If waiting for an observation, resolve it as cancelled
    if (this.pendingObservation) {
      this.pendingObservation.resolve({
        content: "Session aborted",
        isError: true,
      });
      this.pendingObservation = null;
    }

    // Dispose prompter to clear pending permission timers and reject promises
    this.prompter?.dispose();

    // Resolve any pending surface actions
    for (const [, pending] of this.pendingSurfaceActions) {
      pending.resolve({ content: "Session aborted", isError: true });
    }
    this.pendingSurfaceActions.clear();
    this.surfaceState.clear();

    this.state = "error";
    this.sendToClient({
      type: "cu_error",
      sessionId: this.sessionId,
      message: "Session aborted by user",
    });
    this.notifyTerminal();
  }

  isComplete(): boolean {
    return this.state === "complete";
  }

  getState(): string {
    return this.state;
  }

  /**
   * Compute CU tool definitions from the bundled computer-use skill via
   * skill projection. Returns null if projection fails so the caller can
   * fall back to legacy hardcoded tool definitions.
   */
  private getProjectedCuToolDefinitions(): ToolDefinition[] | null {
    if (this.preactivatedSkillIds.length === 0) {
      log.warn(
        "No preactivatedSkillIds configured, falling back to legacy CU tools",
      );
      return null;
    }

    try {
      const projection = projectSkillTools([], {
        preactivatedSkillIds: this.preactivatedSkillIds,
        previouslyActiveSkillIds: this.skillProjectionState,
        cache: this.skillProjectionCache,
      });

      if (projection.allowedToolNames.size === 0) {
        log.warn(
          { preactivatedSkillIds: this.preactivatedSkillIds },
          "Skill projection produced no tool definitions, falling back to legacy CU tools",
        );
        return null;
      }

      // Tool definitions are no longer returned from projectSkillTools
      // (dispatched via skill_execute). Build definitions from the registry.
      const defs: ToolDefinition[] = [];
      for (const name of projection.allowedToolNames) {
        const tool = getTool(name);
        if (tool) defs.push(tool.getDefinition());
      }
      return defs;
    } catch (err) {
      log.warn(
        { err },
        "Skill projection failed, falling back to legacy CU tools",
      );
      return null;
    }
  }

  handleSurfaceAction(
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ): void {
    const pending = this.pendingSurfaceActions.get(surfaceId);
    if (!pending) {
      log.warn({ surfaceId, actionId }, "No pending surface action found");
      return;
    }
    // selection_changed is a non-terminal state update — don't consume the
    // pending entry. The selection state will be in the action button payload.
    if (actionId === "selection_changed") {
      return;
    }
    this.pendingSurfaceActions.delete(surfaceId);
    pending.resolve({
      content: JSON.stringify({ actionId, data: data ?? {} }),
      isError: false,
    });
  }

  // ---------------------------------------------------------------------------
  // Agent loop execution
  // ---------------------------------------------------------------------------

  private async runAgentLoop(messages: Message[]): Promise<void> {
    const systemPrompt = buildComputerUseSystemPrompt(
      this.screenWidth,
      this.screenHeight,
    );

    let cuToolDefs = this.getProjectedCuToolDefinitions();
    if (!cuToolDefs) {
      // Fallback: register the legacy CU tools as skill-origin tools so
      // ToolExecutor can resolve them via getTool(), but using the same
      // ownerSkillId as the bundled computer-use skill. This avoids
      // core-vs-skill collisions that would permanently block skill
      // projection recovery on subsequent sessions.
      const fallbackSkillId = this.preactivatedSkillIds[0] ?? "computer-use";
      const fallbackTools: Tool[] = allComputerUseTools.map((t) => ({
        ...t,
        origin: "skill" as const,
        ownerSkillId: fallbackSkillId,
        ownerSkillBundled: true,
      }));
      registerSkillTools(fallbackTools);
      // Track in the session map so resetSkillToolProjection cleans up
      this.skillProjectionState.set(fallbackSkillId, "fallback");
      cuToolDefs = allComputerUseTools.map((t) => t.getDefinition());
    }

    const toolDefs: ToolDefinition[] = [
      ...cuToolDefs,
      ...allUiSurfaceTools.map((t) => t.getDefinition()),
    ];

    this.prompter = new PermissionPrompter(this.sendToClient);
    const prompter = this.prompter;
    const secretPrompter = new SecretPrompter(this.sendToClient);
    const executor = new ToolExecutor(prompter);

    const proxyResolver = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<ToolExecutionResult> => {
      // ── Surface tool proxying ──────────────────────────────────────
      if (toolName === "ui_show") {
        const surfaceId = uuid();
        const surfaceType = input.surface_type as SurfaceType;
        const title = typeof input.title === "string" ? input.title : undefined;
        const data = input.data as SurfaceData;
        const actions = input.actions as
          | Array<{ id: string; label: string; style?: string }>
          | undefined;
        // Interactive surfaces default to awaiting user action.
        // Tables and lists only block when explicit action buttons are provided;
        // selectionMode alone should not gate blocking because selection_changed
        // fires on every click and would immediately resolve multi-select surfaces.
        const hasActions = Array.isArray(actions) && actions.length > 0;
        const isInteractive =
          surfaceType === "card"
            ? hasActions
            : surfaceType === "list"
              ? hasActions
              : surfaceType === "table"
                ? hasActions
                : INTERACTIVE_SURFACE_TYPES.includes(surfaceType);
        const awaitAction = (input.await_action as boolean) ?? isInteractive;

        // Track surface state for ui_update merging
        this.surfaceState.set(surfaceId, { surfaceType, data, title });

        this.sendToClient({
          type: "ui_surface_show",
          sessionId: this.sessionId,
          surfaceId,
          surfaceType,
          title,
          data,
          actions: actions?.map((a) => ({
            id: a.id,
            label: a.label,
            style: (a.style ?? "secondary") as
              | "primary"
              | "secondary"
              | "destructive",
          })),
        } as unknown as UiSurfaceShow);

        if (awaitAction) {
          return new Promise<ToolExecutionResult>((resolve) => {
            this.pendingSurfaceActions.set(surfaceId, { resolve });
          });
        }
        return { content: JSON.stringify({ surfaceId }), isError: false };
      }

      if (toolName === "ui_update") {
        const surfaceId = input.surface_id as string;
        const patch = input.data as Record<string, unknown>;

        // Merge the partial patch into the stored full surface data
        const stored = this.surfaceState.get(surfaceId);
        let mergedData: SurfaceData;
        if (stored) {
          mergedData = { ...stored.data, ...patch } as SurfaceData;
          stored.data = mergedData;
        } else {
          mergedData = patch as unknown as SurfaceData;
        }

        this.sendToClient({
          type: "ui_surface_update",
          sessionId: this.sessionId,
          surfaceId,
          data: mergedData,
        });
        return { content: "Surface updated", isError: false };
      }

      if (toolName === "ui_dismiss") {
        const surfaceId = input.surface_id as string;
        this.sendToClient({
          type: "ui_surface_dismiss",
          sessionId: this.sessionId,
          surfaceId,
        });
        this.pendingSurfaceActions.delete(surfaceId);
        this.surfaceState.delete(surfaceId);
        return { content: "Surface dismissed", isError: false };
      }

      // ── Computer-use tool proxying ─────────────────────────────────
      const reasoning =
        typeof input.reasoning === "string" ? input.reasoning : undefined;

      // Record action in history
      this.actionHistory.push({
        step: this.stepCount + 1,
        toolName,
        input,
        reasoning,
      });

      // Check for terminal tools
      if (
        toolName === "computer_use_done" ||
        toolName === "computer_use_respond"
      ) {
        const summary =
          toolName === "computer_use_done"
            ? typeof input.summary === "string"
              ? input.summary
              : "Task completed"
            : typeof input.answer === "string"
              ? input.answer
              : "No answer provided";

        this.sendToClient({
          type: "cu_complete",
          sessionId: this.sessionId,
          summary,
          stepCount: this.stepCount,
          isResponse: toolName === "computer_use_respond" ? true : undefined,
        });
        this.state = "complete";
        // Stop AgentLoop immediately so terminal tools cannot trigger extra provider calls.
        this.abortController?.abort();
        this.notifyTerminal();
        return { content: "Session complete", isError: false };
      }

      this.stepCount++;

      // Enforce step limit — abort the loop so toolChoice:'any' can't force another turn
      if (this.stepCount > MAX_STEPS) {
        this.state = "error";
        this.sendToClient({
          type: "cu_error",
          sessionId: this.sessionId,
          message: `Step limit (${MAX_STEPS}) exceeded`,
        });
        this.abortController?.abort();
        this.notifyTerminal();
        return { content: `Step limit (${MAX_STEPS}) exceeded`, isError: true };
      }

      // Send action to client for execution
      this.sendToClient({
        type: "cu_action",
        sessionId: this.sessionId,
        toolName,
        input,
        reasoning,
        stepNumber: this.stepCount,
      });

      // Wait for next observation from client
      this.state = "awaiting_observation";
      return new Promise<ToolExecutionResult>((resolve) => {
        this.pendingObservation = { resolve };
      });
    };

    // Build a set of tool names the CU session is allowed to execute.
    // This prevents tools registered globally (e.g. computer_use_request_control)
    // but not advertised to the CU model from executing during CU sessions.
    const allowedToolNames = new Set(toolDefs.map((td) => td.name));

    const toolExecutor = async (
      name: string,
      input: Record<string, unknown>,
    ): Promise<ToolExecutionResult> => {
      return executor.execute(name, input, {
        workingDir: getSandboxWorkingDir(),
        sessionId: this.sessionId,
        conversationId: this.sessionId,
        trustClass: "guardian",
        proxyToolResolver: proxyResolver,
        allowedToolNames,
        requestSecret: async (params) => {
          return secretPrompter.prompt(
            params.service,
            params.field,
            params.label,
            params.description,
            params.placeholder,
            this.sessionId,
            params.purpose,
            params.allowedTools,
            params.allowedDomains,
          );
        },
      });
    };

    // Wrap the provider so that old AX tree snapshots are stripped from
    // conversation history before each API call, keeping only the most recent
    // MAX_AX_TREES_IN_HISTORY entries.  This prevents TTFT from growing
    // linearly with step count.
    const compactingProvider: Provider = {
      name: this.provider.name,
      sendMessage: (msgs, tools, sys, opts) => {
        const compacted = ComputerUseSession.compactHistory(msgs);
        return this.provider.sendMessage(compacted, tools, sys, opts);
      },
    };

    const toolDefsWithReason = injectReasonField(toolDefs, REASON_SKIP_SET);

    const cuConfig = getConfig();
    const agentLoop = new AgentLoop(
      compactingProvider,
      systemPrompt,
      {
        maxTokens: 4096,
        maxInputTokens: cuConfig.contextWindow.maxInputTokens,
        toolChoice: { type: "any" },
      },
      toolDefsWithReason,
      toolExecutor,
    );

    try {
      await agentLoop.run(
        messages,
        (event) => {
          switch (event.type) {
            case "error":
              log.error(
                { err: event.error, sessionId: this.sessionId },
                "Agent loop error",
              );
              if (this.state !== "complete") {
                this.state = "error";
                this.sendToClient({
                  type: "cu_error",
                  sessionId: this.sessionId,
                  message: event.error.message,
                });
                this.notifyTerminal();
              }
              break;
            case "usage":
              log.info(
                {
                  sessionId: this.sessionId,
                  inputTokens: event.inputTokens,
                  outputTokens: event.outputTokens,
                  model: event.model,
                },
                "Usage",
              );
              break;
            // Other events (text_delta, thinking_delta, etc.) are not surfaced to the CU client
          }
        },
        this.abortController?.signal,
      );

      // If the loop exits without completing, treat as error
      if (this.state !== "complete" && this.state !== "error") {
        this.state = "error";
        this.sendToClient({
          type: "cu_error",
          sessionId: this.sessionId,
          message: "Agent loop ended unexpectedly",
        });
        this.notifyTerminal();
      }
    } catch (err) {
      if (this.abortController?.signal.aborted) {
        log.info({ sessionId: this.sessionId }, "Agent loop aborted");
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, sessionId: this.sessionId }, "Agent loop failed");
      if (this.state !== "complete") {
        this.state = "error";
        this.sendToClient({
          type: "cu_error",
          sessionId: this.sessionId,
          message,
        });
        this.notifyTerminal();
      }
    } finally {
      // Always clean up skill projection state and session timer
      resetSkillToolProjection(this.skillProjectionState);
      if (this.sessionTimer) {
        clearTimeout(this.sessionTimer);
        this.sessionTimer = null;
      }
    }
  }

  private notifyTerminal(): void {
    if (this.terminalNotified) return;
    this.terminalNotified = true;
    resetSkillToolProjection(this.skillProjectionState);
    this.onTerminal?.(this.sessionId);
  }

  // ---------------------------------------------------------------------------
  // History compaction — strip old AX tree snapshots from tool results
  // ---------------------------------------------------------------------------

  /**
   * Returns a shallow copy of `messages` where all but the most recent
   * `MAX_AX_TREES_IN_HISTORY` `<ax-tree>` blocks have been replaced with a
   * short placeholder.  This keeps the conversation context small so that
   * TTFT does not grow linearly with step count.
   */
  static compactHistory(messages: Message[]): Message[] {
    // Collect indices of user messages that contain an <ax-tree> block
    const indicesWithAxTree: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "user") continue;
      for (const block of msg.content) {
        if (
          block.type === "tool_result" &&
          typeof block.content === "string" &&
          block.content.includes("<ax-tree>")
        ) {
          indicesWithAxTree.push(i);
          break;
        }
      }
    }

    if (indicesWithAxTree.length <= MAX_AX_TREES_IN_HISTORY) {
      return messages;
    }

    const toStrip = new Set(
      indicesWithAxTree.slice(0, -MAX_AX_TREES_IN_HISTORY),
    );

    return messages.map((msg, idx) => {
      if (!toStrip.has(idx)) return msg;
      return {
        ...msg,
        content: msg.content.map((block) => {
          if (
            block.type === "tool_result" &&
            typeof block.content === "string" &&
            block.content.includes("<ax-tree>")
          ) {
            return {
              ...block,
              content: block.content.replace(
                AX_TREE_PATTERN,
                AX_TREE_PLACEHOLDER,
              ),
            };
          }
          return block;
        }),
      };
    });
  }

  /**
   * Escapes any literal `</ax-tree>` occurrences inside AX tree content so
   * that the non-greedy compaction regex (`AX_TREE_PATTERN`) does not stop
   * prematurely when the user happens to be viewing XML/HTML source that
   * contains the closing tag.  The escaped content does not need to be
   * unescaped because compaction replaces the entire block with a placeholder.
   */
  static escapeAxTreeContent(content: string): string {
    return content.replace(/<\/ax-tree>/gi, "&lt;/ax-tree&gt;");
  }

  // ---------------------------------------------------------------------------
  // Build rich tool-result content from an observation so the model sees
  // updated screen state on each turn (not just "Action executed").
  // ---------------------------------------------------------------------------

  private buildObservationResultContent(
    obs: CuObservation,
    hadPreviousAXTree: boolean,
  ): string {
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

    // AX tree diff
    if (obs.axDiff) {
      parts.push(obs.axDiff);
      parts.push("");
    } else if (hadPreviousAXTree && obs.axTree != null) {
      const lastAction = this.actionHistory[this.actionHistory.length - 1];
      const wasWait = lastAction?.toolName === "computer_use_wait";
      if (
        this.consecutiveUnchangedSteps >=
        CONSECUTIVE_UNCHANGED_WARNING_THRESHOLD
      ) {
        parts.push(
          `WARNING: ${this.consecutiveUnchangedSteps} consecutive actions had NO VISIBLE EFFECT on the UI. You MUST try a completely different approach.`,
        );
      } else if (!wasWait) {
        parts.push(
          "Your last action had NO VISIBLE EFFECT on the UI. Try something different.",
        );
      }
      parts.push("");
    }

    // Current screen state — wrapped in markers so compactHistory can strip old snapshots
    if (obs.axTree) {
      parts.push("<ax-tree>");
      parts.push("CURRENT SCREEN STATE:");
      parts.push(ComputerUseSession.escapeAxTreeContent(obs.axTree));
      parts.push("</ax-tree>");
    }

    const screenshotMetadata = this.formatScreenshotMetadata(obs);
    if (screenshotMetadata.length > 0) {
      parts.push("");
      parts.push(...screenshotMetadata);
    }

    return parts.join("\n").trim() || "Action executed";
  }

  // ---------------------------------------------------------------------------
  // Message building (replicates AnthropicProvider.buildMessages from Swift)
  // ---------------------------------------------------------------------------

  private buildMessages(
    obs: CuObservation,
    hadPreviousAXTree: boolean,
  ): Message[] {
    const contentBlocks: ContentBlock[] = [];

    // Screenshot image block
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

    // Text block
    const textParts: string[] = [];
    const trimmedTask = this.task.trim();
    if (trimmedTask) {
      textParts.push(`TASK: ${trimmedTask}`);
    } else {
      textParts.push("TASK: No explicit task provided.");
    }
    textParts.push("");

    // AX tree diff (compact summary of what changed)
    if (obs.axDiff && this.actionHistory.length > 0) {
      textParts.push(obs.axDiff);
      textParts.push("");
    } else if (
      hadPreviousAXTree &&
      obs.axTree != null &&
      this.actionHistory.length > 0
    ) {
      // AX tree unchanged — tell the model its action had no effect
      const lastAction = this.actionHistory[this.actionHistory.length - 1];
      const wasWait = lastAction?.toolName === "computer_use_wait";
      textParts.push("CHANGES SINCE LAST ACTION:");
      if (
        this.consecutiveUnchangedSteps >=
        CONSECUTIVE_UNCHANGED_WARNING_THRESHOLD
      ) {
        textParts.push(
          `WARNING: ${this.consecutiveUnchangedSteps} consecutive actions had NO VISIBLE EFFECT on the UI. You MUST try a completely different approach — do not repeat any of your recent actions.`,
        );
      } else if (!wasWait) {
        const actionDesc = `${lastAction?.toolName ?? "unknown"}`;
        textParts.push(
          `Your last action (${actionDesc}) had NO VISIBLE EFFECT on the UI. The screen is identical to the previous step. Do NOT repeat the same action — try something different.`,
        );
      } else {
        textParts.push(
          "No visible changes detected — the UI is identical to the previous step.",
        );
      }
      textParts.push("");
    }

    // Current screen state
    if (obs.axTree) {
      textParts.push(
        "CURRENT SCREEN STATE (accessibility tree of the focused window):",
      );
      textParts.push(obs.axTree);
      textParts.push("");
      textParts.push(
        "Use element_id with the [ID] numbers shown above to target elements.",
      );

      // Secondary windows for cross-app awareness
      if (obs.secondaryWindows) {
        textParts.push("");
        textParts.push(obs.secondaryWindows);
        textParts.push("");
        textParts.push(
          "Note: The element [ID]s above are from other windows — you can reference them for context but can only interact with the focused window's elements.",
        );
      }

      if (obs.screenshot) {
        textParts.push("");
        textParts.push(
          "A screenshot of the FULL SCREEN is also attached above. Use it to see content outside the focused window (e.g., reference documents, PDFs, other apps visible behind the current window).",
        );
        const screenshotMetadata = this.formatScreenshotMetadata(obs);
        if (screenshotMetadata.length > 0) {
          textParts.push(...screenshotMetadata);
        }
      }
    } else if (obs.screenshot) {
      textParts.push("CURRENT SCREEN STATE:");
      textParts.push(
        "See the screenshot above. No accessibility tree available — estimate coordinates from the image.",
      );
      const screenshotMetadata = this.formatScreenshotMetadata(obs);
      if (screenshotMetadata.length > 0) {
        textParts.push(...screenshotMetadata);
      }
    } else {
      textParts.push("CURRENT SCREEN STATE:");
      textParts.push("No screen data available.");
    }

    // Action history
    if (this.actionHistory.length > 0) {
      textParts.push("");
      textParts.push("ACTIONS TAKEN SO FAR:");
      let windowedHistory: ActionRecord[];
      if (this.actionHistory.length > MAX_HISTORY_ENTRIES) {
        textParts.push(
          `  [... ${this.actionHistory.length - MAX_HISTORY_ENTRIES} earlier actions omitted]`,
        );
        windowedHistory = this.actionHistory.slice(-MAX_HISTORY_ENTRIES);
      } else {
        windowedHistory = this.actionHistory;
      }
      for (const record of windowedHistory) {
        const result = record.result ?? "executed";
        textParts.push(`  ${record.step}. ${record.toolName} → ${result}`);
      }
    }

    // Loop detection warning
    if (this.actionHistory.length >= LOOP_DETECTION_WINDOW) {
      const recent = this.actionHistory.slice(-LOOP_DETECTION_WINDOW);
      const allIdentical = recent.every(
        (r) =>
          r.toolName === recent[0].toolName &&
          JSON.stringify(r.input) === JSON.stringify(recent[0].input),
      );
      if (allIdentical) {
        textParts.push("");
        textParts.push(
          `WARNING: You have repeated the exact same action (${recent[0].toolName}) ${LOOP_DETECTION_WINDOW} times in a row. You MUST try a completely different approach or call computer_use_done with an explanation of why you are stuck.`,
        );
      }
    }

    // Surface user guidance prominently
    if (obs.userGuidance) {
      textParts.push("");
      textParts.push(`USER GUIDANCE: ${obs.userGuidance}`);
    }

    // Prompt for next action
    textParts.push("");
    if (this.actionHistory.length === 0) {
      textParts.push(
        "This is the first action. Examine the screen state and decide what to do first.",
      );
    } else {
      textParts.push("Decide the next action to take.");
    }

    contentBlocks.push({
      type: "text",
      text: textParts.join("\n"),
    });

    return [{ role: "user", content: contentBlocks }];
  }

  private formatScreenshotMetadata(obs: CuObservation): string[] {
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
    if (obs.coordinateOrigin) {
      lines.push(`Coordinate origin: ${obs.coordinateOrigin}`);
    }
    if (obs.captureDisplayId != null) {
      lines.push(`Capture display ID: ${obs.captureDisplayId}`);
    }
    return lines;
  }

  hasPendingConfirmation(requestId: string): boolean {
    return this.prompter?.hasPendingRequest(requestId) ?? false;
  }

  handleConfirmationResponse(
    requestId: string,
    decision: UserDecision,
    selectedPattern?: string,
    selectedScope?: string,
    decisionContext?: string,
  ): void {
    this.prompter?.resolveConfirmation(
      requestId,
      decision,
      selectedPattern,
      selectedScope,
      decisionContext,
    );
  }
}

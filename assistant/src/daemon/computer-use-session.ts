/**
 * Computer-use session orchestrator.
 *
 * Manages the observation -> infer -> action loop for computer-use tasks,
 * bridging the macOS client (which captures screen state and executes actions)
 * with the AgentLoop (which runs inference via the Anthropic API with CU tools).
 */

import type { Provider, Message, ContentBlock, ToolDefinition } from '../providers/types.js';
import type { ServerMessage, CuObservation } from './ipc-protocol.js';
import type { ToolExecutionResult } from '../tools/types.js';
import { AgentLoop } from '../agent/loop.js';
import { ToolExecutor } from '../tools/executor.js';
import { PermissionPrompter } from '../permissions/prompter.js';
import { allComputerUseTools } from '../tools/computer-use/definitions.js';
import { buildComputerUseSystemPrompt } from '../config/computer-use-prompt.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('computer-use-session');

const MAX_STEPS = 50;
const MAX_HISTORY_ENTRIES = 10;
const LOOP_DETECTION_WINDOW = 3;
const CONSECUTIVE_UNCHANGED_WARNING_THRESHOLD = 2;

type SessionState = 'idle' | 'awaiting_observation' | 'inferring' | 'complete' | 'error';

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

  private state: SessionState = 'idle';
  private stepCount = 0;
  private actionHistory: ActionRecord[] = [];
  private previousAXTree: string | undefined;
  private consecutiveUnchangedSteps = 0;
  private abortController: AbortController | null = null;

  private pendingObservation: {
    resolve: (result: ToolExecutionResult) => void;
  } | null = null;

  // Tracks the agent loop promise so callers can await session completion
  private loopPromise: Promise<void> | null = null;

  constructor(
    sessionId: string,
    task: string,
    screenWidth: number,
    screenHeight: number,
    provider: Provider,
    sendToClient: (msg: ServerMessage) => void,
  ) {
    this.sessionId = sessionId;
    this.task = task;
    this.screenWidth = screenWidth;
    this.screenHeight = screenHeight;
    this.provider = provider;
    this.sendToClient = sendToClient;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async handleObservation(obs: CuObservation): Promise<void> {
    if (this.state === 'complete' || this.state === 'error') {
      log.warn({ sessionId: this.sessionId, state: this.state }, 'Observation received after session ended');
      return;
    }

    // Track consecutive unchanged steps
    if (this.stepCount > 0) {
      if (obs.axDiff == null && this.previousAXTree != null && obs.axTree != null) {
        this.consecutiveUnchangedSteps++;
      } else if (obs.axDiff != null) {
        this.consecutiveUnchangedSteps = 0;
      }
    }

    // Capture previous AX tree for next turn
    if (obs.axTree != null) {
      this.previousAXTree = obs.axTree;
    }

    if (this.state === 'awaiting_observation' && this.pendingObservation) {
      // Resolve the pending proxy tool result with a summary
      const result: ToolExecutionResult = obs.executionError
        ? { content: `Action failed: ${obs.executionError}`, isError: true }
        : { content: obs.executionResult ?? 'Action executed', isError: false };
      this.pendingObservation.resolve(result);
      this.pendingObservation = null;
      // The agent loop continues automatically after resolution
      return;
    }

    // First observation — start the agent loop
    this.state = 'inferring';
    this.abortController = new AbortController();

    const messages = this.buildMessages(obs);
    this.loopPromise = this.runAgentLoop(messages);

    // Await the loop; errors are caught inside runAgentLoop
    await this.loopPromise;
  }

  abort(): void {
    if (this.state === 'complete' || this.state === 'error') return;

    log.info({ sessionId: this.sessionId }, 'Aborting computer-use session');
    this.abortController?.abort();

    // If waiting for an observation, resolve it as cancelled
    if (this.pendingObservation) {
      this.pendingObservation.resolve({ content: 'Session aborted', isError: true });
      this.pendingObservation = null;
    }

    this.state = 'error';
    this.sendToClient({
      type: 'cu_error',
      sessionId: this.sessionId,
      message: 'Session aborted by user',
    });
  }

  isComplete(): boolean {
    return this.state === 'complete';
  }

  getState(): string {
    return this.state;
  }

  // ---------------------------------------------------------------------------
  // Agent loop execution
  // ---------------------------------------------------------------------------

  private async runAgentLoop(messages: Message[]): Promise<void> {
    const systemPrompt = buildComputerUseSystemPrompt(this.screenWidth, this.screenHeight);
    const toolDefs: ToolDefinition[] = allComputerUseTools.map((t) => t.getDefinition());

    const prompter = new PermissionPrompter(this.sendToClient);
    const executor = new ToolExecutor(prompter);

    const proxyResolver = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<ToolExecutionResult> => {
      const reasoning = typeof input.reasoning === 'string' ? input.reasoning : undefined;

      // Record action in history
      this.actionHistory.push({
        step: this.stepCount + 1,
        toolName,
        input,
        reasoning,
      });

      // Check for terminal tools
      if (toolName === 'cu_done' || toolName === 'cu_respond') {
        const summary =
          toolName === 'cu_done'
            ? (typeof input.summary === 'string' ? input.summary : 'Task completed')
            : (typeof input.answer === 'string' ? input.answer : 'No answer provided');

        this.sendToClient({
          type: 'cu_complete',
          sessionId: this.sessionId,
          summary,
          stepCount: this.stepCount,
        });
        this.state = 'complete';
        return { content: 'Session complete', isError: false };
      }

      this.stepCount++;

      // Enforce step limit
      if (this.stepCount > MAX_STEPS) {
        this.state = 'error';
        this.sendToClient({
          type: 'cu_error',
          sessionId: this.sessionId,
          message: `Step limit (${MAX_STEPS}) exceeded`,
        });
        return { content: `Step limit (${MAX_STEPS}) exceeded`, isError: true };
      }

      // Send action to client for execution
      this.sendToClient({
        type: 'cu_action',
        sessionId: this.sessionId,
        toolName,
        input,
        reasoning,
        stepNumber: this.stepCount,
      });

      // Wait for next observation from client
      this.state = 'awaiting_observation';
      return new Promise<ToolExecutionResult>((resolve) => {
        this.pendingObservation = { resolve };
      });
    };

    const toolExecutor = async (
      name: string,
      input: Record<string, unknown>,
    ): Promise<ToolExecutionResult> => {
      return executor.execute(name, input, {
        workingDir: process.cwd(),
        sessionId: this.sessionId,
        conversationId: this.sessionId,
        proxyToolResolver: proxyResolver,
      });
    };

    const agentLoop = new AgentLoop(
      this.provider,
      systemPrompt,
      {
        maxTokens: 4096,
        toolChoice: { type: 'any' },
      },
      toolDefs,
      toolExecutor,
    );

    try {
      await agentLoop.run(
        messages,
        (event) => {
          switch (event.type) {
            case 'error':
              log.error({ err: event.error, sessionId: this.sessionId }, 'Agent loop error');
              if (this.state !== 'complete') {
                this.state = 'error';
                this.sendToClient({
                  type: 'cu_error',
                  sessionId: this.sessionId,
                  message: event.error.message,
                });
              }
              break;
            case 'usage':
              log.info({
                sessionId: this.sessionId,
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                model: event.model,
              }, 'Usage');
              break;
            // Other events (text_delta, thinking_delta, etc.) are not surfaced to the CU client
          }
        },
        this.abortController?.signal,
      );

      // If the loop exits without completing, treat as error
      if (this.state !== 'complete' && this.state !== 'error') {
        this.state = 'error';
        this.sendToClient({
          type: 'cu_error',
          sessionId: this.sessionId,
          message: 'Agent loop ended unexpectedly',
        });
      }
    } catch (err) {
      if (this.abortController?.signal.aborted) {
        log.info({ sessionId: this.sessionId }, 'Agent loop aborted');
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, sessionId: this.sessionId }, 'Agent loop failed');
      if (this.state !== 'complete') {
        this.state = 'error';
        this.sendToClient({
          type: 'cu_error',
          sessionId: this.sessionId,
          message,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Message building (replicates AnthropicProvider.buildMessages from Swift)
  // ---------------------------------------------------------------------------

  private buildMessages(obs: CuObservation): Message[] {
    const contentBlocks: ContentBlock[] = [];

    // Screenshot image block
    if (obs.screenshot) {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
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
      textParts.push('TASK: No explicit task provided.');
    }
    textParts.push('');

    // AX tree diff (compact summary of what changed)
    if (obs.axDiff && this.actionHistory.length > 0) {
      textParts.push(obs.axDiff);
      textParts.push('');
    } else if (obs.previousAXTree != null && obs.axTree != null && this.actionHistory.length > 0) {
      // AX tree unchanged — tell the model its action had no effect
      const lastAction = this.actionHistory[this.actionHistory.length - 1];
      const wasWait = lastAction?.toolName === 'cu_wait';
      textParts.push('CHANGES SINCE LAST ACTION:');
      if (this.consecutiveUnchangedSteps >= CONSECUTIVE_UNCHANGED_WARNING_THRESHOLD) {
        textParts.push(
          `WARNING: ${this.consecutiveUnchangedSteps} consecutive actions had NO VISIBLE EFFECT on the UI. You MUST try a completely different approach — do not repeat any of your recent actions.`,
        );
      } else if (!wasWait) {
        const actionDesc = `${lastAction?.toolName ?? 'unknown'}`;
        textParts.push(
          `Your last action (${actionDesc}) had NO VISIBLE EFFECT on the UI. The screen is identical to the previous step. Do NOT repeat the same action — try something different.`,
        );
      } else {
        textParts.push('No visible changes detected — the UI is identical to the previous step.');
      }
      textParts.push('');
    }

    // Current screen state
    if (obs.axTree) {
      textParts.push('CURRENT SCREEN STATE (accessibility tree of the focused window):');
      textParts.push(obs.axTree);
      textParts.push('');
      textParts.push('Use element_id with the [ID] numbers shown above to target elements.');

      // Secondary windows for cross-app awareness
      if (obs.secondaryWindows) {
        textParts.push('');
        textParts.push(obs.secondaryWindows);
        textParts.push('');
        textParts.push(
          "Note: The element [ID]s above are from other windows — you can reference them for context but can only interact with the focused window's elements.",
        );
      }

      if (obs.screenshot) {
        textParts.push('');
        textParts.push(
          'A screenshot of the FULL SCREEN is also attached above. Use it to see content outside the focused window (e.g., reference documents, PDFs, other apps visible behind the current window).',
        );
      }
    } else if (obs.screenshot) {
      textParts.push('CURRENT SCREEN STATE:');
      textParts.push('See the screenshot above. No accessibility tree available — estimate coordinates from the image.');
    } else {
      textParts.push('CURRENT SCREEN STATE:');
      textParts.push('No screen data available.');
    }

    // Action history
    if (this.actionHistory.length > 0) {
      textParts.push('');
      textParts.push('ACTIONS TAKEN SO FAR:');
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
        const result = record.result ?? 'executed';
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
        textParts.push('');
        textParts.push(
          `WARNING: You have repeated the exact same action (${recent[0].toolName}) ${LOOP_DETECTION_WINDOW} times in a row. You MUST try a completely different approach or call cu_done with an explanation of why you are stuck.`,
        );
      }
    }

    // Prompt for next action
    textParts.push('');
    if (this.actionHistory.length === 0) {
      textParts.push('This is the first action. Examine the screen state and decide what to do first.');
    } else {
      textParts.push('Decide the next action to take.');
    }

    contentBlocks.push({
      type: 'text',
      text: textParts.join('\n'),
    });

    return [{ role: 'user', content: contentBlocks }];
  }
}

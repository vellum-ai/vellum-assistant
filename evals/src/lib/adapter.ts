import type { Profile } from "./profile";
import type { TestSetupCommand } from "./setup-command";

export interface AgentMessage {
  content: string;
}

export interface AgentEvent {
  id?: string;
  assistantId?: string;
  emittedAt?: string;
  message: {
    type: string;
    text?: string;
    thinking?: string;
    toolName?: string;
    input?: Record<string, unknown>;
    result?: string;
    isError?: boolean;
    riskLevel?: string;
    riskReason?: string;
    content?: string;
    message?: string;
    chunk?: string;
    [key: string]: unknown;
  };
}

export interface AgentHatchInput {
  profile: Profile;
  testId: string;
  runId?: string;
}

/**
 * Input for `BaseAgent.writeWorkspaceFile`. The path is resolved
 * *relative to the agent's workspace root* — adapters MUST reject any
 * path that escapes the workspace (e.g. `../`, absolute paths).
 *
 * Used by file-on-disk injection contracts where the runner needs to
 * stage a payload (haystack, fixtures, …) into the agent's view of
 * disk *before* sending the message that asks it to read them. The
 * LongMemEval-V2 two-conversation flow is the first concrete user.
 */
export interface WorkspaceFileWrite {
  /** Workspace-relative path. Must not escape the workspace root. */
  path: string;
  /** Bytes to write. UTF-8 strings are written as-is. */
  content: string;
}

/**
 * Input for `BaseAgent.confirm`. Resolves a pending tool confirmation
 * the agent raised (via a `confirmation_request` event) when a tool
 * exceeded its auto-approve risk threshold.
 */
export interface ConfirmationDecision {
  /** The `requestId` carried on the `confirmation_request` event. */
  requestId: string;
  /** Whether to approve or reject the pending tool call. */
  decision: "allow" | "deny";
}

/**
 * A loadable, self-contained HTML page for an app the agent produced.
 *
 * `html` is fully inlined — every script and stylesheet the page needs
 * is embedded, so it renders identically when handed to
 * `page.setContent(html)` in an offline browser with no network or
 * asset server. This keeps app interaction uniform across species: the
 * harness always drives a single static document regardless of how the
 * agent built or compiled it.
 */
export interface ResolvedAppPage {
  /** Self-contained HTML with all assets inlined. */
  html: string;
}

/**
 * Extract the `requestId` from a pending tool-confirmation event, or
 * `undefined` if the event isn't a `confirmation_request`. A hatched
 * assistant runs headless with no interactive approver, so any tool the
 * agent reaches for above the auto-approve risk threshold stalls on such
 * an event until something answers it.
 */
export function confirmationRequestId(event: AgentEvent): string | undefined {
  if (event.message.type !== "confirmation_request") return undefined;
  const requestId = event.message.requestId;
  return typeof requestId === "string" && requestId.length > 0
    ? requestId
    : undefined;
}

export interface BaseAgent {
  readonly id: string;
  readonly conversationKey: string;
  hatch(): Promise<void>;
  send(message: AgentMessage): Promise<void>;
  runSetupCommand(command: TestSetupCommand): Promise<void>;
  events(): AsyncIterable<AgentEvent>;
  /**
   * Whether `event` is the species' turn-completion signal — the event
   * the agent emits when it has finished responding to the most recent
   * `send`. The runner's event collector waits for this signal instead
   * of inferring turn boundaries from stream silence, so a turn with a
   * long silent phase (memory retrieval, extended thinking, slow tools)
   * is never cut off mid-flight.
   */
  isTurnComplete(event: AgentEvent): boolean;
  readUsageRecords?(): Promise<Array<Record<string, unknown>>>;
  shutdown(): Promise<void>;
  /**
   * Write a file into the agent's workspace. Optional capability:
   * adapters that don't expose a writable workspace boundary may omit
   * this method, and `runIngestAsk` will throw a clear "this profile's
   * adapter doesn't support workspace file injection" error if a caller
   * tries to use it.
   */
  writeWorkspaceFile?(input: WorkspaceFileWrite): Promise<void>;
  /**
   * Open a fresh conversation against the same agent process. The
   * agent's persistent state (memory layer, workspace files, hatched
   * container) survives; only the chat history resets. After this
   * resolves, `conversationKey` reflects the new conversation.
   *
   * Optional capability — adapters that don't expose multi-conversation
   * flows may omit. `runIngestAsk` checks for this method up-front and
   * throws a clear error if it's missing.
   */
  newConversation?(): Promise<void>;
  /**
   * Resolve a pending tool confirmation the agent raised. Optional
   * capability: species whose tools never gate on confirmation (or that
   * run with everything auto-approved) may omit it. Runners that auto
   * approve `confirmation_request` events in a headless run check for
   * this method and skip approval when it's absent.
   */
  confirm?(input: ConfirmationDecision): Promise<void>;
  /**
   * Resolve the app the agent built into a single loadable HTML page, or
   * `undefined` when the agent produced no app this run. Optional
   * capability: species that can't surface an inspectable app omit it,
   * and the runner skips the app-interaction phase when it's absent.
   *
   * The returned HTML is self-contained (assets inlined), so the runner
   * can drive any species' app through one uniform static-page path
   * without knowing how it was built or compiled.
   */
  resolveAppPage?(): Promise<ResolvedAppPage | undefined>;
}

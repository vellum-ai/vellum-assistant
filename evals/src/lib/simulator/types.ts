import type { AgentMessage } from "../adapter";
import type { TestDef } from "../test-def";
import type { TranscriptTurn } from "../transcript";

/**
 * A tool the tested agent paused on mid-turn (via a `confirmation_request`
 * event) because it exceeded the auto-approve risk threshold and needs the
 * user to approve or reject it.
 */
export interface ToolConfirmationRequest {
  toolName: string;
  input: Record<string, unknown>;
  riskLevel?: string;
  riskReason?: string;
}

export interface SimulatorInput {
  test: TestDef;
  transcript: TranscriptTurn[];
  /**
   * Set when the agent has paused mid-turn awaiting the user's approval. The
   * simulator resolves the pending confirmation instead of taking the next
   * turn; absent, it decides the next user message (or to end).
   */
  pendingConfirmation?: ToolConfirmationRequest;
}

export type SimulatorDecision =
  | { action: "send"; message: AgentMessage; reason?: string }
  | { action: "end"; reason: string }
  | { action: "confirm"; decision: "allow" | "deny"; reason?: string };

export interface Simulator {
  /**
   * Make the simulator's next decision given the conversation so far. With a
   * `pendingConfirmation`, that decision is to allow or deny the paused tool
   * (in the user's voice, since the headless agent has no human approver);
   * otherwise it is the next user message or ending the conversation.
   */
  decide(input: SimulatorInput): Promise<SimulatorDecision>;
}

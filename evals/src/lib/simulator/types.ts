import type { AgentMessage } from "../adapter";
import type { TestDef } from "../test-def";
import type { TranscriptTurn } from "../transcript";

export interface SimulatorInput {
  test: TestDef;
  transcript: TranscriptTurn[];
}

export type SimulatorDecision =
  | { action: "send"; message: AgentMessage; reason?: string }
  | { action: "end"; reason: string };

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

export interface ConfirmationInput {
  test: TestDef;
  transcript: TranscriptTurn[];
  request: ToolConfirmationRequest;
}

/** The simulated user's answer to a pending tool confirmation. */
export interface ConfirmationVerdict {
  decision: "allow" | "deny";
  reason?: string;
}

export interface Simulator {
  decide(input: SimulatorInput): Promise<SimulatorDecision>;
  /**
   * Answer a pending tool confirmation as the user the simulator is playing.
   * The agent runs headless with no human approver, so the simulator — which
   * already drives the user side of the conversation — decides whether the
   * tool advances the SPEC's goal (allow) or should be refused (deny). This
   * keeps confirmation handling in the user's voice instead of a blanket
   * harness-side approval.
   */
  confirmTool(input: ConfirmationInput): Promise<ConfirmationVerdict>;
}

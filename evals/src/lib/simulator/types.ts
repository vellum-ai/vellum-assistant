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

export interface Simulator {
  decide(input: SimulatorInput): Promise<SimulatorDecision>;
}

import type { AgentEvent, AgentMessage } from "../adapter";
import type { TestDef } from "../test-def";

export interface SimulatorInput {
  test: TestDef;
  assistantEvents: AgentEvent[];
  transcript: Array<{ role: "simulator" | "assistant"; content: string }>;
}

export type SimulatorDecision =
  | { action: "send"; message: AgentMessage; reason?: string }
  | { action: "end"; reason: string };

export interface Simulator {
  decide(input: SimulatorInput): Promise<SimulatorDecision>;
}

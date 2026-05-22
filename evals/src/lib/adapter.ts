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

export interface BaseAgent {
  readonly id: string;
  readonly conversationKey: string;
  hatch(): Promise<void>;
  send(message: AgentMessage): Promise<void>;
  runSetupCommand(command: TestSetupCommand): Promise<void>;
  events(): AsyncIterable<AgentEvent>;
  readUsageRecords?(): Promise<Array<Record<string, unknown>>>;
  shutdown(): Promise<void>;
}

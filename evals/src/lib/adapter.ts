import type { Profile } from "./profile";

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
  events(): AsyncIterable<AgentEvent>;
  shutdown(): Promise<void>;
}

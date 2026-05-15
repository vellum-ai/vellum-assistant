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

export interface RunningAgent {
  readonly id: string;
  readonly conversationKey: string;
  send(message: AgentMessage): Promise<void>;
  events(): AsyncIterable<AgentEvent>;
  shutdown(): Promise<void>;
}

export interface AgentAdapter {
  spawn(input: {
    profile: Profile;
    testId: string;
    runId?: string;
  }): Promise<RunningAgent>;
}

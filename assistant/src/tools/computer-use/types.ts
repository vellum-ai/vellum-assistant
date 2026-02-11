/** Shared input types for computer-use tools, mirroring the macOS client's ToolDefinitions.swift schemas. */

export interface ClickInput {
  element_id?: number;
  x?: number;
  y?: number;
  reasoning: string;
}

export interface TypeTextInput {
  text: string;
  reasoning: string;
}

export interface KeyInput {
  key: string;
  reasoning: string;
}

export interface ScrollInput {
  element_id?: number;
  x?: number;
  y?: number;
  direction: 'up' | 'down' | 'left' | 'right';
  amount: number;
  reasoning: string;
}

export interface DragInput {
  element_id?: number;
  x?: number;
  y?: number;
  to_element_id?: number;
  to_x?: number;
  to_y?: number;
  reasoning: string;
}

export interface WaitInput {
  duration_ms: number;
  reasoning: string;
}

export interface OpenAppInput {
  app_name: string;
  reasoning: string;
}

export interface RunAppleScriptInput {
  script: string;
  reasoning: string;
}

export interface DoneInput {
  summary: string;
}

export interface RespondInput {
  answer: string;
  reasoning: string;
}

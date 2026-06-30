// Background bash/host_bash command lifecycle types.

// === Server → Client (streamed via SSE) ===

export interface BackgroundToolStarted {
  type: "background_tool_started";
  id: string;
  toolName: string;
  conversationId: string;
  command: string;
  startedAt: number;
}

export interface BackgroundToolCompleted {
  type: "background_tool_completed";
  id: string;
  conversationId: string;
  status: "completed" | "failed" | "cancelled";
  exitCode?: number | null;
  output?: string;
  completedAt: number;
}

// --- Domain-level union alias (consumed by message-protocol.ts) ---

export type _BackgroundToolsServerMessages =
  | BackgroundToolStarted
  | BackgroundToolCompleted;

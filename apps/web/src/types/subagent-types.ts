/**
 * Client-side types for subagent detail responses.
 *
 * The daemon route schema declares `events: z.array(z.unknown())` so the
 * generated SDK types events as `Array<unknown>`. These interfaces reflect
 * the actual runtime shape from `parseSubagentMessages()` in the daemon's
 * subagents-routes.ts.
 */

export interface SubagentEvent {
  type: string;
  content: string;
  toolName?: string;
  isError?: boolean;
  messageId?: string;
  text?: string;
  result?: string;
  timestamp?: number;
}

export interface SubagentDetailResponse {
  subagentId: string;
  objective: string;
  status?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  };
  events: SubagentEvent[];
}

import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import { toolInvocations } from './schema.js';

export interface ToolInvocationRecord {
  conversationId: string;
  toolName: string;
  input: string;
  result: string;
  decision: string;
  riskLevel: string;
  durationMs: number;
}

export function recordToolInvocation(record: ToolInvocationRecord): void {
  const db = getDb();
  db.insert(toolInvocations).values({
    id: uuid(),
    conversationId: record.conversationId,
    toolName: record.toolName,
    input: record.input,
    result: record.result,
    decision: record.decision,
    riskLevel: record.riskLevel,
    durationMs: record.durationMs,
    createdAt: Date.now(),
  }).run();
}

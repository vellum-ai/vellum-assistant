import { and, asc, eq, gt, or } from "drizzle-orm";

import { getDb } from "./db.js";
import { messages } from "./schema.js";

export interface TurnEvent {
  id: string;
  createdAt: number;
}

/**
 * Query user messages (turns) that haven't been reported to telemetry yet.
 * Uses a compound cursor (createdAt + id) for reliable watermarking.
 */
export function queryUnreportedTurnEvents(
  afterCreatedAt: number,
  afterId: string | undefined,
  limit: number,
): TurnEvent[] {
  const db = getDb();
  const rows = db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.role, "user"),
        afterId
          ? or(
              gt(messages.createdAt, afterCreatedAt),
              and(
                eq(messages.createdAt, afterCreatedAt),
                gt(messages.id, afterId),
              ),
            )
          : gt(messages.createdAt, afterCreatedAt),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(limit)
    .all();
  return rows;
}

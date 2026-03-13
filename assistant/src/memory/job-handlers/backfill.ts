import { and, asc, eq, gt, or } from "drizzle-orm";

import type { AssistantConfig } from "../../config/types.js";
import type { TrustClass } from "../../runtime/actor-trust-resolver.js";
import {
  readMessageCursorCheckpoint,
  resetMessageCursorCheckpoint,
  writeMessageCursorCheckpoint,
} from "../checkpoints.js";
import {
  getConversationMemoryScopeId,
  messageMetadataSchema,
} from "../conversation-crud.js";
import { getDb } from "../db.js";
import { indexMessageNow } from "../indexer.js";
import { enqueueMemoryJob, type MemoryJob } from "../jobs-store.js";
import { messages } from "../schema.js";

const BACKFILL_CHECKPOINT_KEY = "memory:backfill:last_created_at";
const BACKFILL_CHECKPOINT_ID_KEY = "memory:backfill:last_message_id";

function parseProvenanceTrustClass(
  rawMetadata: string | null,
): TrustClass | undefined {
  if (!rawMetadata) return undefined;
  try {
    const parsed = messageMetadataSchema.safeParse(JSON.parse(rawMetadata));
    if (!parsed.success) return undefined;
    return parsed.data.provenanceTrustClass;
  } catch {
    return undefined;
  }
}

export function backfillJob(job: MemoryJob, config: AssistantConfig): void {
  const db = getDb();
  const force = job.payload.force === true;
  if (force) {
    resetMessageCursorCheckpoint(
      BACKFILL_CHECKPOINT_KEY,
      BACKFILL_CHECKPOINT_ID_KEY,
    );
  }

  const cursor = readMessageCursorCheckpoint(
    BACKFILL_CHECKPOINT_KEY,
    BACKFILL_CHECKPOINT_ID_KEY,
  );
  const batch = db
    .select()
    .from(messages)
    .where(
      or(
        gt(messages.createdAt, cursor.createdAt),
        and(
          eq(messages.createdAt, cursor.createdAt),
          gt(messages.id, cursor.messageId),
        ),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(200)
    .all();

  if (batch.length > 0) {
    const scopeCache = new Map<string, string>();
    for (const message of batch) {
      let scopeId = scopeCache.get(message.conversationId);
      if (scopeId === undefined) {
        scopeId = getConversationMemoryScopeId(message.conversationId);
        scopeCache.set(message.conversationId, scopeId);
      }
      const provenanceTrustClass = parseProvenanceTrustClass(
        message.metadata ?? null,
      );
      indexMessageNow(
        {
          messageId: message.id,
          conversationId: message.conversationId,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          scopeId,
          provenanceTrustClass,
        },
        config.memory,
      );
    }
    const lastMessage = batch[batch.length - 1];
    writeMessageCursorCheckpoint(
      BACKFILL_CHECKPOINT_KEY,
      BACKFILL_CHECKPOINT_ID_KEY,
      {
        createdAt: lastMessage.createdAt,
        messageId: lastMessage.id,
      },
    );
  }

  if (batch.length === 200) {
    enqueueMemoryJob("backfill", {});
  }
}

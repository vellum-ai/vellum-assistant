import { and, asc, eq, gt, ne, or } from "drizzle-orm";

import type { AssistantConfig } from "../../config/types.js";
import type { TrustClass } from "../../runtime/actor-trust-resolver.js";
import { getLogger } from "../../util/logger.js";
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
import {
  enqueueBackfillEntityRelationsJob,
  enqueueMemoryJob,
  type MemoryJob,
} from "../jobs-store.js";
import { messages } from "../schema.js";

const log = getLogger("memory-jobs-worker");

const BACKFILL_CHECKPOINT_KEY = "memory:backfill:last_created_at";
const BACKFILL_CHECKPOINT_ID_KEY = "memory:backfill:last_message_id";
const RELATION_BACKFILL_CHECKPOINT_KEY =
  "memory:relation_backfill:last_created_at";
const RELATION_BACKFILL_CHECKPOINT_ID_KEY =
  "memory:relation_backfill:last_message_id";

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

function isTrustedTrustClass(trustClass: TrustClass | undefined): boolean {
  return trustClass === "guardian" || trustClass === undefined;
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
  } else if (
    config.memory.entity.enabled &&
    config.memory.entity.extractRelations.enabled
  ) {
    // Enqueue after the terminal batch (including an empty batch when total
    // messages are an exact multiple of 200) so the relation backfill does not
    // overlap with messages the normal backfill already covered via
    // indexMessageNow → extract_items → extract_entities.
    enqueueBackfillEntityRelationsJob();
  }
}

export function backfillEntityRelationsJob(
  job: MemoryJob,
  config: AssistantConfig,
): void {
  if (!config.memory.entity.enabled) return;
  if (!config.memory.entity.extractRelations.enabled) return;

  const force = job.payload.force === true;
  if (force) {
    resetMessageCursorCheckpoint(
      RELATION_BACKFILL_CHECKPOINT_KEY,
      RELATION_BACKFILL_CHECKPOINT_ID_KEY,
    );
  }

  const db = getDb();
  const cursor = readMessageCursorCheckpoint(
    RELATION_BACKFILL_CHECKPOINT_KEY,
    RELATION_BACKFILL_CHECKPOINT_ID_KEY,
  );
  const batchSize = Math.max(
    1,
    config.memory.entity.extractRelations.backfillBatchSize,
  );

  const afterCursor = or(
    gt(messages.createdAt, cursor.createdAt),
    and(
      eq(messages.createdAt, cursor.createdAt),
      gt(messages.id, cursor.messageId),
    ),
  );

  // Honor extractFromAssistant config — same role filter as indexMessageNow
  const roleFilter = config.memory.extraction.extractFromAssistant
    ? undefined
    : ne(messages.role, "assistant");

  const conditions = roleFilter ? and(afterCursor, roleFilter) : afterCursor;

  const batch = db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      role: messages.role,
      createdAt: messages.createdAt,
      metadata: messages.metadata,
    })
    .from(messages)
    .where(conditions)
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(batchSize)
    .all();
  if (batch.length === 0) return;

  const scopeCache = new Map<string, string>();
  let queuedExtractEntityJobs = 0;
  let skippedUntrusted = 0;
  for (const message of batch) {
    const provenanceTrustClass = parseProvenanceTrustClass(
      message.metadata ?? null,
    );
    if (!isTrustedTrustClass(provenanceTrustClass)) {
      skippedUntrusted += 1;
      continue;
    }
    let scopeId = scopeCache.get(message.conversationId);
    if (scopeId === undefined) {
      scopeId = getConversationMemoryScopeId(message.conversationId);
      scopeCache.set(message.conversationId, scopeId);
    }
    enqueueMemoryJob("extract_entities", { messageId: message.id, scopeId });
    queuedExtractEntityJobs += 1;
  }

  const lastMessage = batch[batch.length - 1];
  writeMessageCursorCheckpoint(
    RELATION_BACKFILL_CHECKPOINT_KEY,
    RELATION_BACKFILL_CHECKPOINT_ID_KEY,
    {
      createdAt: lastMessage.createdAt,
      messageId: lastMessage.id,
    },
  );

  if (batch.length === batchSize) {
    enqueueBackfillEntityRelationsJob();
  }

  log.debug(
    {
      queuedExtractEntityJobs,
      skippedUntrusted,
      batchSize,
      lastCreatedAt: lastMessage.createdAt,
      lastMessageId: lastMessage.id,
    },
    "Queued relation backfill batch",
  );
}

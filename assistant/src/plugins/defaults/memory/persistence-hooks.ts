import { getConfig } from "../../../config/loader.js";
import type {
  ConversationForkedEvent,
  MemoryPersistenceHooks,
  MessagePersistedEvent,
} from "../../../persistence/memory-lifecycle-hooks.js";
import { forkGraphMemoryState } from "./graph/graph-memory-state-store.js";
import { indexMessageNow } from "./indexer.js";
import {
  enqueueLexicalIndexForMessage,
  enqueuePurgeConversationLexical,
} from "./job-handlers/index-message-lexical.js";
import { sweepOrphanMemoryRetrospectiveConversations } from "./memory-retrospective-startup-cleanup.js";
import { forkRetrospectiveState } from "./memory-retrospective-state.js";
import { cancelPendingJobsForConversation } from "./task-memory-cleanup.js";
import {
  forkActivationState,
  seedForkActivationState,
} from "./v2/activation-store.js";
import {
  extractInjectedConceptSlugs,
  readInjectedBlock,
} from "./v2/injected-block-slugs.js";
import {
  forkEverInjected,
  MEMORY_V3_INJECTED_BLOCK_METADATA_KEY,
  seedEverInjectedFromSlugs,
} from "./v3/ever-injected-store.js";

/**
 * The memory feature's implementation of the persistence lifecycle seam
 * (`MemoryPersistenceHooks`). Registered into the seam at plugin bootstrap so
 * the persistence layer can drive memory side effects without importing memory
 * internals.
 */
export const memoryPersistenceHooks: MemoryPersistenceHooks = {
  async onMessagePersisted(event: MessagePersistedEvent): Promise<void> {
    await indexMessageNow({ ...event, scopeId: "default" }, getConfig().memory);
    // Dual-write into the lexical (Qdrant) index off the write path. Self-gated
    // on memory-enabled; the upsert is idempotent so a redundant enqueue is
    // harmless.
    enqueueLexicalIndexForMessage(event.messageId);
  },

  onConversationForked(event: ConversationForkedEvent): void {
    const {
      db,
      sourceConversationId,
      forkId,
      isFullHistoryFork,
      messagesToCopy,
      forkedMessageIds,
      inheritedCompactedMessageCount,
    } = event;

    // Carry the parent's per-conversation memory state into the child so the
    // forked thread resumes with the same activation/injection log and
    // in-context tracker the parent had at fork time. Only valid for
    // full-history forks: a truncated fork would inherit activation/tracker
    // entries for turns the child does not actually contain.
    if (isFullHistoryFork) {
      forkActivationState(db, sourceConversationId, forkId);
      forkEverInjected(db, sourceConversationId, forkId);
      forkGraphMemoryState(sourceConversationId, forkId);
    } else {
      // Truncated fork: the wholesale copy above would over-claim, but
      // seeding nothing makes the child re-select and re-attach every page
      // whose `<memory>` attachment it already inherited (observed in
      // production: 89 duplicate page injections on one fork). Derive
      // `everInjected` from the inherited attachments themselves — scoped to
      // the child's visible window, since attachments behind an inherited
      // compaction boundary are not rendered and must stay re-injectable.
      // The v2 and v3 layers persist under separate metadata keys with the
      // same `# memory/concepts/<slug>.md` header convention, so each seeds
      // its own dedup record from its own blocks.
      const visibleStartIndex = Math.min(
        inheritedCompactedMessageCount,
        messagesToCopy.length,
      );
      const inheritedSlugs = new Set<string>();
      const inheritedV3Slugs = new Set<string>();
      for (const message of messagesToCopy.slice(visibleStartIndex)) {
        const block = readInjectedBlock(
          message.metadata,
          "memoryInjectedBlock",
        );
        if (block) {
          for (const slug of extractInjectedConceptSlugs(block)) {
            inheritedSlugs.add(slug);
          }
        }
        const v3Block = readInjectedBlock(
          message.metadata,
          MEMORY_V3_INJECTED_BLOCK_METADATA_KEY,
        );
        if (v3Block) {
          for (const slug of extractInjectedConceptSlugs(v3Block)) {
            inheritedV3Slugs.add(slug);
          }
        }
      }
      seedForkActivationState(db, forkId, [...inheritedSlugs]);
      seedEverInjectedFromSlugs(
        db,
        sourceConversationId,
        forkId,
        [...inheritedV3Slugs],
        Date.now(),
      );
    }
    forkRetrospectiveState({
      database: db,
      sourceConversationId,
      forkedConversationId: forkId,
      forkedMessageIds,
      lastCopiedSourceMessageId: messagesToCopy.at(-1)?.id ?? null,
    });
  },

  onConversationWiped(conversationId: string): number {
    // Purge the conversation's points from the lexical (Qdrant) index. Cleanup
    // path — runs even while the plugin is disabled so points written while it
    // was enabled are not orphaned.
    enqueuePurgeConversationLexical(conversationId);
    return cancelPendingJobsForConversation(conversationId);
  },

  onWorkerStartup(): void {
    sweepOrphanMemoryRetrospectiveConversations();
  },
};

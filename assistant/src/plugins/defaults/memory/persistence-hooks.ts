import type { DrizzleDb } from "../../../persistence/db-connection.js";
import { forkGraphMemoryState } from "./graph/graph-memory-state-store.js";
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

/** A conversation was forked; the memory feature carries per-conversation state into the child. */
export interface ConversationForkedEvent {
  db: DrizzleDb;
  sourceConversationId: string;
  forkId: string;
  /**
   * Full-history fork (the child contains every source message). When false the
   * fork is truncated and per-conversation memory state is re-derived from the
   * child's visible window instead of copied wholesale.
   */
  isFullHistoryFork: boolean;
  /** The copied messages, in order. Only `id` and `metadata` are read. */
  messagesToCopy: ReadonlyArray<{ id: string; metadata: string | null }>;
  /** Map of source message id → forked message id. */
  forkedMessageIds: Map<string, string>;
  /** Count of inherited messages behind the fork's compaction boundary. */
  inheritedCompactedMessageCount: number;
}

/**
 * The memory plugin's persistence-lifecycle handlers. The persistence layer's
 * conversation write paths (`conversation-crud.ts`) import this object
 * directly and invoke the relevant handler at each lifecycle point — the one
 * documented persistence → memory back-import in the persistence-layering
 * guard, to be unwound by exposing these events through the first-class
 * `hooks` system.
 *
 * The direct import puts this module on an import cycle (persistence imports
 * it; it transitively imports persistence). The cycle is benign: every
 * binding on it is read at call time — the persistence call sites invoke the
 * handlers inside functions, and this object references its imports only
 * inside method bodies — so no module body ever observes a half-initialized
 * module.
 */
export const memoryPersistenceHooks = {
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

  onConversationDeleted(conversationId: string): void {
    // Fail the conversation's still-pending memory jobs (graph extraction,
    // summary builds, …) — the rows they reference are gone. The cancellation
    // sweeps pending `conversationId`-keyed jobs, so the delete primitive
    // fires this hook BEFORE enqueueing the conversation's lexical purge, or
    // the purge would be swept too.
    cancelPendingJobsForConversation(conversationId);
  },
};

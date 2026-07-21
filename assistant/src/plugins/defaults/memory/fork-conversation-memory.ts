import type { DrizzleDb } from "../../../persistence/db-connection.js";
import { forkGraphMemoryState } from "./graph/graph-memory-state-store.js";
import { forkRetrospectiveState } from "./memory-retrospective-state.js";
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

/** Inputs to {@link forkConversationMemory}. */
export interface ForkConversationMemoryInput {
  db: DrizzleDb;
  sourceConversationId: string;
  forkId: string;
  /**
   * True when the fork branches from the source's tip: its rendered window
   * equals the source's, so per-conversation memory state is carried
   * wholesale. When false the fork is truncated and state is re-derived from
   * the child's visible window instead.
   */
  isFullHistoryFork: boolean;
  /** The copied messages, in order. Only `id` and `metadata` are read. */
  messagesToCopy: ReadonlyArray<{ id: string; metadata: string | null }>;
  /** Map of source message id → forked message id. */
  forkedMessageIds: Map<string, string>;
  /**
   * Count of leading `messagesToCopy` entries behind the fork's compaction
   * boundary (0 when the copied range already starts at the visible window).
   */
  inheritedCompactedMessageCount: number;
}

/**
 * Carry the parent's per-conversation memory state into a freshly forked child
 * (activation and injection logs, graph state, retrospective state).
 *
 * The persistence layer's fork path (`conversation-crud.ts`) imports this
 * directly and calls it synchronously inside the fork's DB transaction,
 * threading the live transaction handle so the child's memory state commits
 * atomically with the fork. This is a persistence → memory back-import
 * documented in the persistence-layering guard; unlike the other
 * persistence-lifecycle events it is a direct call rather than a first-class
 * `hooks` dispatch, because the async hooks pipeline cannot run inside a
 * synchronous transaction with a live handle.
 *
 * The direct import puts this module on an import cycle (persistence imports
 * it; it transitively imports persistence). The cycle is benign: the binding
 * is read at call time — the persistence call site invokes this inside a
 * function, and this module references its imports only inside the function
 * body — so no module body ever observes a half-initialized module.
 */
export function forkConversationMemory(
  input: ForkConversationMemoryInput,
): void {
  const {
    db,
    sourceConversationId,
    forkId,
    isFullHistoryFork,
    messagesToCopy,
    forkedMessageIds,
    inheritedCompactedMessageCount,
  } = input;

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
      const block = readInjectedBlock(message.metadata, "memoryInjectedBlock");
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
}

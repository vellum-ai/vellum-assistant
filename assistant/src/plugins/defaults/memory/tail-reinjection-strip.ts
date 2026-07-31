/**
 * Tail idempotency strip for the post-compaction re-injection path.
 *
 * `applyRuntimeInjections` applies each per-turn injection block to the tail
 * user message without first removing an existing copy, so handing it a base
 * whose tail already carries injected blocks — the post-compaction continuation
 * history — would produce a second copy of every non-presence-gated block.
 * Stripping the full per-turn injection set from the tail first makes
 * re-injection idempotent: the result holds exactly one copy of each block
 * regardless of what the base carried.
 *
 * The strip is owned by the memory plugin (the re-injection caller),
 * keeping injection idempotency a property of the injection machinery rather
 * than of the agent loop that drives compaction.
 */
import type { Message } from "@vellumai/plugin-api";

import {
  type InjectionMatcher,
  RUNTIME_INJECTION_PREFIXES,
  stripTailUserTextBlocksByPrefix,
} from "../../../context/strip-injections.js";

/**
 * Per-turn blocks that `stripInjectionsForCompaction` deliberately keeps in the
 * durable, summarized history but that still ride into the re-injection base on
 * the tail, so they must be cleared from the tail to keep re-injection
 * idempotent:
 *
 *  - `<turn_context>` — kept in history for temporal/actor grounding.
 *  - `<config_reset_notice>` — kept so a reset stays visible across turns.
 *  - `<active_documents>` / `<document_comments>` — kept so open-document and
 *    comment awareness survives summarization.
 *
 * Each uses the full `{ prefix, suffix }` wrapper so user-authored text merely
 * opening with one of these tags is never mistaken for an injected block.
 */
const REINJECTION_TAIL_ONLY_MATCHERS: InjectionMatcher[] = [
  { prefix: "<turn_context>\n", suffix: "\n</turn_context>" },
  { prefix: "<config_reset_notice>\n", suffix: "\n</config_reset_notice>" },
  { prefix: "<active_documents>\n", suffix: "\n</active_documents>" },
  { prefix: "<document_comments>\n", suffix: "\n</document_comments>" },
];

/**
 * The complete per-turn injection set applied to the tail user message: the
 * compaction strip set plus the blocks compaction keeps in durable history.
 */
const REINJECTION_TAIL_STRIP_MATCHERS: InjectionMatcher[] = [
  ...RUNTIME_INJECTION_PREFIXES,
  ...REINJECTION_TAIL_ONLY_MATCHERS,
];

/**
 * Clear every per-turn injected block from the tail user message so a
 * subsequent `applyRuntimeInjections` produces exactly one copy of each block.
 */
export function stripTailInjectionsForReinjection(
  messages: Message[],
): Message[] {
  return stripTailUserTextBlocksByPrefix(
    messages,
    REINJECTION_TAIL_STRIP_MATCHERS,
  );
}

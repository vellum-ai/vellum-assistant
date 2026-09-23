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
  PER_TURN_INJECTION_MATCHERS,
  stripTailUserTextBlocksByPrefix,
} from "../../../context/strip-injections.js";

/**
 * Clear every per-turn injected block from the tail user message so a
 * subsequent `applyRuntimeInjections` produces exactly one copy of each block.
 */
export function stripTailInjectionsForReinjection(
  messages: Message[],
): Message[] {
  return stripTailUserTextBlocksByPrefix(messages, PER_TURN_INJECTION_MATCHERS);
}

/**
 * Default `memoryRetrieval` post-compaction hook.
 *
 * After the agent loop compacts a conversation mid-turn it must re-apply the
 * runtime injections compaction stripped — the NOW.md scratchpad, PKB context,
 * memory-v2 static block, workspace top-level context, and Slack chronological
 * snapshot — onto the compacted history before the turn continues. This hook
 * is the memory system's home for that transform: it receives the message
 * history plus the resolved runtime-injection options and returns the edited
 * history (and the blocks it captured), with no dependency on the agent loop's
 * closure state.
 *
 * It delegates to {@link applyRuntimeInjections} today. The remaining
 * orchestrator-side re-injection steps (memory-graph re-tracking, historical
 * web-search stripping, and the post-injection bookkeeping the loop records)
 * are expected to migrate here as the hook subsumes the loop's re-injection
 * ceremony.
 */

import {
  applyRuntimeInjections,
  type RuntimeInjectionOptions,
  type RuntimeInjectionResult,
} from "../../../../daemon/conversation-runtime-assembly.js";
import type { Message } from "../../../../providers/types.js";

export default async function postCompactReinject(
  history: Message[],
  options: RuntimeInjectionOptions,
): Promise<RuntimeInjectionResult> {
  return applyRuntimeInjections(history, options);
}

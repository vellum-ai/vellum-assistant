import { z } from "zod";

import {
  getSubagentRecordById,
  getSubagentRecordByLabel,
} from "../../persistence/subagent-store.js";
import {
  getSubagentManager,
  normalizeSubagentLabel,
  settleUnsupervisedStatus,
  subagentStateFromRecord,
} from "../../subagent/index.js";
import type { SubagentState } from "../../subagent/types.js";
import { nullAsOmitted } from "../shared/zod-tool-schema.js";
import type { ToolContext } from "../types.js";

/**
 * Shared model-input schema for the subagent tools that address an existing
 * subagent by `subagent_id` or `label` (`subagent_status` / `subagent_abort`,
 * extended by `subagent_message` / `subagent_read`). Same in-tool pattern and
 * TOOLS.json drift guard as the other bundled-skill tools — see
 * `subagent-tool-input-schemas.test.ts` and the schema block in
 * `tools/document/document-tool.ts` for the framework. The
 * '"subagent_id" or "label" is required' / not-found error messages stay
 * bespoke in each executor.
 */
export const subagentRefInputSchema = z.looseObject({
  subagent_id: nullAsOmitted(z.string()),
  label: nullAsOmitted(z.string()),
});

export type SubagentRefInput = z.infer<typeof subagentRefInputSchema>;

/**
 * Resolve a subagent ID from parsed tool input.
 * Accepts either `subagent_id` (direct UUID) or `label` (case-insensitive lookup).
 */
export function resolveSubagentId(
  input: SubagentRefInput,
  context: ToolContext,
): string | undefined {
  if (input.subagent_id) {
    return input.subagent_id;
  }
  if (input.label) {
    // A label names the newest spawn that claimed it. `rehydrateFromDb` is the
    // one path that rebuilds the index from a subset of rows, and it picks that
    // subset by completion time, which does not follow spawn order: a restart
    // can leave the index on an older run while the newer one survives only as
    // a row. Consult both and compare spawn times rather than trusting either
    // alone. The durable lookup is scoped to the calling conversation, so a
    // label can only name that conversation's own children.
    const live = getSubagentManager().getByLabel(
      input.label,
      context.conversationId,
    );
    const record = getSubagentRecordByLabel(
      context.conversationId,
      normalizeSubagentLabel(input.label),
    );
    if (!live) {
      return record?.id;
    }
    if (!record || record.id === live.config.id) {
      return live.config.id;
    }
    if (record.createdAt !== live.createdAt) {
      return record.createdAt > live.createdAt ? record.id : live.config.id;
    }
    // Spawned in the same millisecond, so the timestamps cannot order them. A
    // live entry that has a row was itself a candidate in the durable lookup,
    // which already broke the tie by insertion order, so the row it picked is
    // the later spawn. A live entry with no row has not persisted yet, which
    // only a spawn still in flight can be, so that one is the later spawn.
    return getSubagentRecordById(live.config.id) ? record.id : live.config.id;
  }
  return undefined;
}

/**
 * The subagent state the read-only subagent tools act on: live manager state,
 * else the durable row. The manager holds a bounded window (the TTL sweep drops
 * terminal entries, a restart rebuilds only the most recently finished ones),
 * and the row outlives both, so this keeps the bound a memory optimization
 * instead of making an older subagent unaddressable.
 *
 * Deliberately not folded into `SubagentManager.getState()`: the route surfaces
 * read the record themselves and branch on whether live state existed.
 *
 * A row-backed state carries `parentConversationId`, so callers apply their
 * ownership check to it unchanged. Tools that need a live instance
 * (`subagent_message`) must keep using `getState()` directly.
 */
export function resolveSubagentState(
  subagentId: string,
): SubagentState | undefined {
  const live = getSubagentManager().getState(subagentId);
  if (live) {
    return live;
  }
  const record = getSubagentRecordById(subagentId);
  if (!record) {
    return undefined;
  }
  // Reaching here means the manager holds no entry, so nothing is executing
  // this run: report it settled rather than telling the caller to wait for
  // something that will never finish. A genuinely live subagent cannot get
  // here, because `spawn()` inserts into the in-memory map before it persists
  // the row, and the only removal (`dispose()`) aborts a non-terminal child
  // first.
  const state = subagentStateFromRecord(record);
  return { ...state, status: settleUnsupervisedStatus(state.status) };
}

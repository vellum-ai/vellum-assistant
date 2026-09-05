import { safeParseRecord } from "../util/json.js";

/**
 * The metadata JSON a message row holds after `updates` is shallow-merged
 * into its stored envelope: the merge behind `updateMessageMetadata` and
 * `updateMessageContentAndMetadata` in `conversation-crud.ts`. A malformed
 * stored envelope reads as empty, so the update stamping the row never fails
 * on it. An `undefined` value DELETES its key (`JSON.stringify` drops it),
 * which is how a caller removes a per-turn key the metadata schema types as
 * `string | absent`.
 */
export function mergeMessageMetadata(
  existing: string | null | undefined,
  updates: Record<string, unknown>,
): string {
  return JSON.stringify({
    ...(existing ? safeParseRecord(existing) : {}),
    ...updates,
  });
}

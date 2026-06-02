/**
 * Default `persistence` behavior: writes conversation messages to the database
 * (and optionally the JSONL disk view).
 *
 * This module is side-effect free: importing it does not register any plugin.
 *
 * The handler dispatches on the discriminated {@link PersistArgs.op} field:
 *
 * - `add`           → {@link addMessage}, optionally followed by
 *                     {@link syncMessageToDisk} when `args.syncToDisk` is true.
 * - `reserve`       → {@link reserveMessage} — pre-allocates an empty row
 *                     for assistant anchor stamping.
 * - `updateContent` → {@link updateMessageContent} — overwrites an existing
 *                     row's content (returns `void`, wrapped as
 *                     `{ op: "updateContent" }`).
 * - `update`        → {@link updateMessageMetadata} (returns `void`, wrapped
 *                     as `{ op: "update" }`).
 * - `delete`        → {@link deleteMessageById} (returns the segment/summary
 *                     IDs the caller must clean up out-of-band).
 */

import {
  addMessage,
  deleteMessageById,
  reserveMessage,
  updateMessageContent,
  updateMessageMetadata,
} from "../../../memory/conversation-crud.js";
import { syncMessageToDisk } from "../../../memory/conversation-disk-view.js";
import type { PersistArgs, PersistResult } from "../../types.js";

/**
 * Persist a message according to `args.op`. Exported so the agent-loop call
 * sites can invoke it directly and tests can verify each op in isolation.
 */
export async function defaultPersistenceTerminal(
  args: PersistArgs,
): Promise<PersistResult> {
  switch (args.op) {
    case "add": {
      const message = await addMessage(
        args.conversationId,
        args.role,
        args.content,
        {
          metadata: args.metadata,
          ...args.addOptions,
        },
      );
      // Sync the just-persisted row to the JSONL disk view when the caller
      // opted in. The handler that emits tool-result rows sets
      // `syncToDisk: true` so the disk view stays in lockstep with the DB.
      if (args.syncToDisk && args.createdAtMs !== undefined) {
        syncMessageToDisk(args.conversationId, message.id, args.createdAtMs);
      }
      return { op: "add", message };
    }
    case "reserve": {
      const message = await reserveMessage(
        args.conversationId,
        args.role,
        args.metadata,
      );
      return { op: "reserve", message };
    }
    case "updateContent": {
      updateMessageContent(args.messageId, args.content);
      return { op: "updateContent" };
    }
    case "update": {
      updateMessageMetadata(args.messageId, args.updates);
      return { op: "update" };
    }
    case "delete": {
      const deleted = deleteMessageById(args.messageId);
      return {
        op: "delete",
        segmentIds: deleted.segmentIds,
        deletedSummaryIds: deleted.deletedSummaryIds,
      };
    }
  }
}

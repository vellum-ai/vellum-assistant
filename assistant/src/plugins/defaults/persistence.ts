/**
 * Default `persistence` plugin.
 *
 * The plugin's middleware is a passthrough — it calls `next(args)` and returns
 * the result unchanged. The actual dispatch lives in
 * {@link defaultPersistenceTerminal}, which is wired in as the pipeline's
 * `terminal` argument by `runPipeline` call sites in
 * `daemon/conversation-agent-loop.ts` and
 * `daemon/conversation-agent-loop-handlers.ts`. This separation matters: the
 * default plugin is registered before any user plugin (defaults load first in
 * `bootstrapPlugins()`), which puts it at the OUTERMOST position of the onion
 * chain. If the default middleware were to invoke the terminal directly
 * without calling `next`, it would shadow every later-registered plugin.
 * Routing through `next(args)` lets user middleware participate normally.
 *
 * The terminal dispatches on the discriminated {@link PersistArgs.op} field:
 *
 * - `add`    → {@link addMessage}, optionally followed by
 *              {@link syncMessageToDisk} when `args.syncToDisk` is true.
 * - `update` → {@link updateMessageMetadata} (returns `void`, wrapped as
 *              `{ op: "update" }`).
 * - `delete` → {@link deleteMessageById} (returns the segment/summary IDs
 *              the caller must clean up out-of-band).
 *
 * Manifest declares `provides.persistence: "v1"` so other plugins can
 * negotiate against the pipeline surface and `requires.pluginRuntime: "v1"`
 * to satisfy the registry's mandatory capability check.
 *
 * Registered from `daemon/external-plugins-bootstrap.ts` via a side-effect
 * import so the plugin is present in the registry before
 * {@link bootstrapPlugins} walks it.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 27).
 */

import { getConfig } from "../../config/loader.js";
import {
  addMessage,
  deleteMessageById,
  getMessageById,
  messageMetadataSchema,
  updateMessageContent,
  updateMessageContentAndMetadata,
  updateMessageMetadata,
} from "../../memory/conversation-crud.js";
import { syncMessageToDisk } from "../../memory/conversation-disk-view.js";
import { indexMessageNow } from "../../memory/indexer.js";
import { getLogger } from "../../util/logger.js";
import { registerPlugin } from "../registry.js";

const log = getLogger("default-persistence");
import {
  type Middleware,
  type PersistArgs,
  type PersistResult,
  type Plugin,
  PluginExecutionError,
} from "../types.js";

/**
 * Terminal handler for the `persistence` pipeline. Exported so tests can
 * verify default behavior directly without going through `runPipeline`, and
 * so the `daemon/conversation-agent-loop*.ts` call sites can pass it as the
 * `terminal` argument to `runPipeline`.
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
        args.metadata,
        args.addOptions,
      );
      // Sync the just-persisted row to the JSONL disk view when the caller
      // opted in. The handler that emits tool-result rows sets
      // `syncToDisk: true` so the disk view stays in lockstep with the DB.
      if (args.syncToDisk && args.createdAtMs !== undefined) {
        syncMessageToDisk(args.conversationId, message.id, args.createdAtMs);
      }
      return { op: "add", message };
    }
    case "update": {
      updateMessageMetadata(args.messageId, args.updates);
      return { op: "update" };
    }
    case "update_content": {
      // Finalize the content of a pre-allocated assistant anchor row at
      // `message_complete`. When metadata is also supplied, both fields are
      // written atomically so a partial write cannot leak. The metadata path
      // takes a shallow merge against the existing row (matching the
      // semantics of the `update` op) so callers can supply only the keys
      // they want to set rather than re-stating the full envelope.
      if (args.metadataUpdates) {
        updateMessageContentAndMetadata(
          args.messageId,
          args.content,
          args.metadataUpdates,
        );
      } else {
        updateMessageContent(args.messageId, args.content);
      }

      // Index the just-finalized content. Mirrors the addMessage path —
      // when the anchor row was originally inserted at turn start its
      // content was the empty marker, so `indexMessageNow` early-returned
      // (indexer.ts:69-71). Now that content is real we run indexing
      // exactly as if this had been a fresh row insert. Non-fatal: a
      // failure here must not block the turn from completing.
      try {
        const row = getMessageById(args.messageId);
        if (row) {
          const parsed = row.metadata
            ? messageMetadataSchema.safeParse(JSON.parse(row.metadata))
            : null;
          const provenanceTrustClass = parsed?.success
            ? parsed.data.provenanceTrustClass
            : undefined;
          const automated = parsed?.success ? parsed.data.automated : undefined;
          await indexMessageNow(
            {
              messageId: row.id,
              conversationId: row.conversationId,
              role: row.role,
              content: row.content,
              createdAt: row.createdAt,
              scopeId: "default",
              provenanceTrustClass,
              automated,
            },
            getConfig().memory,
          );
        }
      } catch (err) {
        log.warn(
          { err, messageId: args.messageId },
          "Failed to index message after update_content (non-fatal)",
        );
      }
      return { op: "update_content" };
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

const passthrough: Middleware<PersistArgs, PersistResult> = async (
  args,
  next,
) => next(args);

export const defaultPersistencePlugin: Plugin = {
  manifest: {
    name: "default-persistence",
    version: "1.0.0",
  },
  middleware: {
    persistence: passthrough,
  },
};

// Module-load side effect: register this default at import time so
// downstream consumers (including tests that skip `bootstrapPlugins()`)
// observe a populated registry by default. Idempotent via the swallowed
// duplicate-name check. Kept local to this module (rather than iterating
// an array in `defaults/index.ts`) so the registration only references
// the already-initialized `defaultPersistencePlugin` identifier —
// avoiding a TDZ crash when tests `mock.module(...)` a dependency of any
// other default plugin and directly import this file.
try {
  registerPlugin(defaultPersistencePlugin);
} catch (err) {
  if (
    err instanceof PluginExecutionError &&
    err.message.includes("already registered")
  ) {
    // already registered — expected when both index.ts and the direct
    // file are imported in the same process
  } else {
    throw err;
  }
}

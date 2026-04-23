/**
 * Default `persistence` plugin — the passthrough terminal that delegates to
 * the message-CRUD functions in `memory/conversation-crud.ts` and (for `add`
 * ops with `syncToDisk: true`) the disk-view projector in
 * `memory/conversation-disk-view.ts`.
 *
 * The plugin system wraps every message-persistence operation in the
 * `persistence` pipeline. This default ensures the pipeline always has a
 * terminal to fall through to when no other plugin short-circuits or
 * overrides it: it dispatches on the discriminated `op` field and calls the
 * matching underlying function with identical arguments.
 *
 * Registered from `daemon/external-plugins-bootstrap.ts` via a side-effect
 * import so the plugin is present in the registry before
 * {@link bootstrapPlugins} walks it.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 27).
 */

import {
  addMessage,
  deleteMessageById,
  updateMessageMetadata,
} from "../../memory/conversation-crud.js";
import { syncMessageToDisk } from "../../memory/conversation-disk-view.js";
import { registerPlugin } from "../registry.js";
import {
  type PersistArgs,
  type PersistResult,
  type Plugin,
  PluginExecutionError,
} from "../types.js";

/**
 * The default persistence plugin. Its sole contribution is the `persistence`
 * middleware, which narrows on {@link PersistArgs.op} and dispatches:
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
 */
export const defaultPersistencePlugin: Plugin = {
  manifest: {
    name: "default-persistence",
    version: "1.0.0",
    provides: { persistence: "v1" },
    requires: { pluginRuntime: "v1" },
  },
  middleware: {
    persistence: async function defaultPersistence(
      args: PersistArgs,
      _next,
      _ctx,
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
          // Sync the just-persisted row to the JSONL disk view when the
          // caller opted in. Mirrors the pattern in the pre-pipeline call
          // sites (handler emits tool-result rows, then syncs them) so the
          // default plugin preserves observable behavior.
          if (args.syncToDisk && args.createdAtMs !== undefined) {
            syncMessageToDisk(
              args.conversationId,
              message.id,
              args.createdAtMs,
            );
          }
          return { op: "add", message };
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
    },
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

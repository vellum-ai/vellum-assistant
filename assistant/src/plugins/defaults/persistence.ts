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

import {
  addMessage,
  deleteMessageById,
  reserveMessage,
  updateMessageContent,
  updateMessageMetadata,
} from "../../memory/conversation-crud.js";
import { syncMessageToDisk } from "../../memory/conversation-disk-view.js";
import { registerPlugin } from "../registry.js";
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

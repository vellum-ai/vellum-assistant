/**
 * Builds the `logger` capability the pipeline stamps onto every hook context.
 * Constructed per hook alongside `broadcast`, so each hook's log lines carry
 * its own attribution — the hook name, the owning plugin (or workspace), and
 * the conversation / request identity when the dispatching context has them —
 * without the hook tagging anything itself.
 */

import type { HookEventOwner } from "../api/events/hook-event.js";
import type { HookName } from "../plugin-api/constants.js";
import { getLogger } from "../util/logger.js";
import type { PluginLogger } from "./types.js";

const log = getLogger("hooks");

export function makeHookLogger(meta: {
  hookName: HookName;
  owner: HookEventOwner;
  conversationId?: string;
  requestId?: string;
}): PluginLogger {
  return log.child({
    hook: meta.hookName,
    plugin: meta.owner.id,
    ...(meta.conversationId != null && { conversationId: meta.conversationId }),
    ...(meta.requestId != null && { requestId: meta.requestId }),
  });
}

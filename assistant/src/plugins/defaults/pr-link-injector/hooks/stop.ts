/**
 * Default `stop` hook for the pr-link-injector plugin.
 *
 * Clears the per-conversation PR link state when the turn terminates, so the
 * next run starts fresh. Mirrors the pattern used by the empty-response and
 * surface-completion-nudge plugins.
 */

import type { PluginHookFn, StopContext } from "@vellumai/plugin-api";

import { clearPrLink } from "../pr-link-store.js";

const stop: PluginHookFn<StopContext> = async (ctx) => {
  clearPrLink(ctx.conversationId);
};

export default stop;

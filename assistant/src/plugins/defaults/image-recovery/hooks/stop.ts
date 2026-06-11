/**
 * Default `stop` hook: clears the per-conversation image-recovery bound when a
 * turn terminates.
 *
 * The `post-model-call` hook (see `./post-model-call.ts`) owns the recovery
 * decision and clears the bound on every outcome it resolves. One terminal it
 * does not resolve is a retry the loop's per-run backstop overrides: when the
 * hook marks the bound and requests `"continue"` but the backstop refuses it,
 * the loop surfaces the rejection through the terminal `stop` chain without
 * re-running `post-model-call`, which would otherwise strand the mark and make
 * the next turn treat its first image-too-large rejection as the exhausted
 * second attempt. Clearing here on the terminal stop closes that gap so the
 * next turn recovers afresh.
 *
 * A `"continue"` decision means a hook is re-querying the model this turn, so
 * the bound must survive to keep the one-pass-per-turn guarantee; only a
 * terminal `"stop"` clears it.
 */

import type { PluginHookFn, StopContext } from "@vellumai/plugin-api";

import { clearImageRecoveryAttempted } from "../image-recovery-state-store.js";

const stop: PluginHookFn<StopContext> = async (ctx) => {
  if (ctx.decision !== "stop") return;
  clearImageRecoveryAttempted(ctx.conversationId);
};

export default stop;

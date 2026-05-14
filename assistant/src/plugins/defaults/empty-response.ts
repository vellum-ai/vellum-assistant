/**
 * Default `emptyResponse` plugin.
 *
 * The plugin's middleware is a passthrough — it calls `next(args)` and returns
 * the result unchanged. The actual decision lives in
 * {@link defaultEmptyResponseTerminal}, which is wired in as the pipeline's
 * `terminal` argument by the `runPipeline` call site in `agent/loop.ts`. This
 * separation matters: the default plugin is registered before any user plugin
 * (defaults load first in `bootstrapPlugins()`), which puts it at the
 * OUTERMOST position of the onion chain. If the default middleware were to
 * decide directly without calling `next`, it would shadow every
 * later-registered plugin. Routing through `next(args)` lets user middleware
 * participate normally.
 *
 * Wiring the terminal at the call site (rather than relying on the plugin to
 * be registered) also means the loop's nudge/accept/error behavior survives
 * configurations that boot without the default plugin — e.g. unit tests that
 * skip `bootstrapPlugins()`.
 *
 * The terminal inspects the turn snapshot and returns one of:
 *
 * 1. `"nudge"`  — the turn produced no visible text, no tool calls, follows
 *                 at least one prior tool-use turn, and the retry counter is
 *                 below `maxEmptyResponseRetries`. The loop appends `nudgeText`
 *                 (one of the `<system_notice>…` messages below) as a `user`
 *                 turn and re-queries the model.
 * 2. `"accept"` — every other case. The turn either has visible output, is
 *                 still in progress (tool calls pending), has no prior tool
 *                 use, or exhausted its retry budget. The loop pushes the
 *                 assistant message and continues normally.
 *
 * The default never returns `"error"` — that action is an escape hatch for
 * downstream plugins (e.g. a circuit breaker) that want to surface an
 * explicit error instead of silently absorbing an empty turn.
 *
 * `MAX_EMPTY_RESPONSE_RETRIES` lives in `agent/loop.ts` and is threaded into
 * the pipeline via `EmptyResponseArgs.maxEmptyResponseRetries` so the cap is
 * declared in one place only.
 */

import { registerPlugin } from "../registry.js";
import {
  type EmptyResponseArgs,
  type EmptyResponseResult,
  type Middleware,
  type Plugin,
  PluginExecutionError,
} from "../types.js";

/**
 * Canonical nudge text. Must stay verbatim so a plugin that wraps the
 * default cannot accidentally see a different string.
 *
 * Wire-compat note: this is shown to the LLM, not the user. Edits here
 * affect model behavior but not end-user UX directly.
 */
const NUDGE_TEXT =
  "<system_notice>Your previous response was empty. You must respond to the user with a summary of what you found or did. Do not use any tools — just respond with text.</system_notice>";

/**
 * Variant used when the model streamed some text before a later tool call but
 * then returned an empty follow-up after the tool result. This is the common
 * "preamble + side-effect tool + silent end" failure mode; ask it to continue
 * instead of re-sending text the user already saw.
 */
const CONTINUATION_NUDGE_TEXT =
  "<system_notice>Your previous response ended after a tool result without any final assistant text. Continue the answer now, using the tool result if relevant. Do not repeat already-visible text verbatim. Do not use any tools — respond with text.</system_notice>";

/**
 * Terminal handler for the `emptyResponse` pipeline. Exported so tests can
 * verify default behavior directly without going through `runPipeline`, and
 * so `agent/loop.ts` can pass it as the `terminal` argument to `runPipeline`.
 */
export function defaultEmptyResponseTerminal(
  args: EmptyResponseArgs,
): EmptyResponseResult {
  const hasVisibleText = args.responseContent.some(
    (block) =>
      block.type === "text" &&
      typeof (block as { text?: unknown }).text === "string" &&
      (block as { text: string }).text.trim().length > 0,
  );

  const isEmptyTurn =
    !hasVisibleText && args.toolUseBlocksLength === 0 && args.toolUseTurns > 0;

  if (isEmptyTurn && args.emptyResponseRetries < args.maxEmptyResponseRetries) {
    return {
      action: "nudge",
      nudgeText: args.priorAssistantHadVisibleText
        ? CONTINUATION_NUDGE_TEXT
        : NUDGE_TEXT,
    };
  }
  return { action: "accept" };
}

const passthrough: Middleware<EmptyResponseArgs, EmptyResponseResult> = async (
  args,
  next,
) => next(args);

/** Singleton plugin — the registry rejects duplicate registrations by name. */
export const defaultEmptyResponsePlugin: Plugin = {
  manifest: {
    name: "default-empty-response",
    version: "1.0.0",
  },
  middleware: {
    emptyResponse: passthrough,
  },
};

// Module-load side effect: register this default at import time so
// downstream consumers (including tests that skip `bootstrapPlugins()`)
// observe a populated registry by default. Idempotent via the swallowed
// duplicate-name check. Kept local to this module (rather than iterating
// an array in `defaults/index.ts`) so the registration only references
// the already-initialized `defaultEmptyResponsePlugin` identifier —
// avoiding a TDZ crash when tests `mock.module(...)` a dependency of any
// other default plugin and directly import this file.
try {
  registerPlugin(defaultEmptyResponsePlugin);
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

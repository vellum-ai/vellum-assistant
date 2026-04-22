/**
 * Default plugin for the `emptyResponse` pipeline.
 *
 * Wraps the historic inline empty-response handling from
 * `agent/loop.ts` (see the comment block around `MAX_EMPTY_RESPONSE_RETRIES`).
 *
 * The pipeline is invoked once per assistant turn after an LLM response
 * lands. The default middleware inspects the turn snapshot and decides:
 *
 * 1. `"nudge"`  — the turn produced no visible text, no tool calls, follows
 *                 at least one prior tool-use turn, no earlier turn in this
 *                 run() has already delivered visible text, AND the retry
 *                 counter is below `maxEmptyResponseRetries`. The loop
 *                 appends `nudgeText` (the historic `<system_notice>…`
 *                 message) as a `user` turn and re-queries the model.
 * 2. `"accept"` — every other case. The turn either legitimately ended
 *                 (model said its piece earlier), is still in progress
 *                 (tool calls pending), or exhausted its retry budget. The
 *                 loop pushes the assistant message and continues normally.
 *
 * The default never returns `"error"` — that action is an escape hatch for
 * downstream plugins (e.g. a circuit breaker) that want to surface an
 * explicit error instead of silently absorbing an empty turn.
 *
 * `MAX_EMPTY_RESPONSE_RETRIES` lives in `agent/loop.ts` and is threaded into
 * the pipeline via `EmptyResponseArgs.maxEmptyResponseRetries` so the cap is
 * declared in one place only.
 */

import type { Plugin } from "../types.js";

/**
 * Historic nudge text. Must stay verbatim so an existing plugin that wraps
 * the default cannot accidentally see a different string.
 *
 * Wire-compat note: this is shown to the LLM, not the user. Edits here
 * affect model behavior but not end-user UX directly.
 */
const NUDGE_TEXT =
  "<system_notice>Your previous response was empty. You must respond to the user with a summary of what you found or did. Do not use any tools — just respond with text.</system_notice>";

/** Singleton plugin — the registry rejects duplicate registrations by name. */
export const defaultEmptyResponsePlugin: Plugin = {
  manifest: {
    name: "default-empty-response",
    version: "1.0.0",
    provides: { emptyResponseApi: "v1" },
    requires: { pluginRuntime: "v1", emptyResponseApi: "v1" },
  },
  middleware: {
    /**
     * Terminal decision maker. Middleware wrapping this one may observe the
     * decision via `next(args)` and override it — e.g. a plugin could force
     * `"accept"` under a feature-flag, or turn an exhausted-retries case
     * into `"error"` for louder telemetry.
     */
    emptyResponse: async (args, _next, _ctx) => {
      const hasVisibleText = args.responseContent.some(
        (block) =>
          block.type === "text" &&
          typeof (block as { text?: unknown }).text === "string" &&
          (block as { text: string }).text.trim().length > 0,
      );

      const isEmptyTurn =
        !hasVisibleText &&
        args.toolUseBlocksLength === 0 &&
        args.toolUseTurns > 0 &&
        !args.priorAssistantHadVisibleText;

      if (
        isEmptyTurn &&
        args.emptyResponseRetries < args.maxEmptyResponseRetries
      ) {
        return { action: "nudge", nudgeText: NUDGE_TEXT };
      }
      return { action: "accept" };
    },
  },
};

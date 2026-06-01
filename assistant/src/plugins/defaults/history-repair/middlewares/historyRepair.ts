import type {
  HistoryRepairArgs,
  HistoryRepairResult,
  Middleware,
} from "../../../types.js";

/**
 * Passthrough middleware for the `historyRepair` pipeline. Forwards to
 * `next(args)` unchanged; the actual repair lives in the terminal handler
 * (`../terminal.ts`), wired in at the `runPipeline` call sites in
 * `daemon/conversation-agent-loop.ts`.
 *
 * Defaults register at the OUTERMOST onion position, so deciding here without
 * calling `next` would shadow every later-registered plugin. Routing through
 * `next(args)` lets user middleware participate normally — and gives overrides
 * both `history` and `provider` so they can route behavior per provider.
 */
const passthrough: Middleware<HistoryRepairArgs, HistoryRepairResult> = async (
  args,
  next,
) => next(args);

export default passthrough;

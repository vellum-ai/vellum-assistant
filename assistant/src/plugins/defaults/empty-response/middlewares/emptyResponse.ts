import type {
  EmptyResponseArgs,
  EmptyResponseResult,
  Middleware,
} from "../../../types.js";

/**
 * Passthrough middleware for the `emptyResponse` pipeline. Forwards to
 * `next(args)` unchanged; the actual empty-response decision lives in the
 * terminal handler (`../terminal.ts`), wired in at the `runPipeline` call site
 * in `agent/loop.ts`.
 *
 * Defaults register at the OUTERMOST onion position, so deciding here without
 * calling `next` would shadow every later-registered plugin. Routing through
 * `next(args)` lets user middleware participate normally.
 */
const passthrough: Middleware<EmptyResponseArgs, EmptyResponseResult> = async (
  args,
  next,
) => next(args);

export default passthrough;

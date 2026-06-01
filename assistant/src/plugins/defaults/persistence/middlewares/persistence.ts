import type { Middleware, PersistArgs, PersistResult } from "../../../types.js";

/**
 * Passthrough middleware for the `persistence` pipeline. Forwards to
 * `next(args)` unchanged; the actual dispatch lives in the terminal handler
 * (`../terminal.ts`), wired in at the `runPipeline` call sites in
 * `daemon/conversation-agent-loop.ts` and
 * `daemon/conversation-agent-loop-handlers.ts`.
 *
 * Defaults register at the OUTERMOST onion position, so deciding here without
 * calling `next` would shadow every later-registered plugin. Routing through
 * `next(args)` lets user middleware participate normally.
 */
const passthrough: Middleware<PersistArgs, PersistResult> = async (
  args,
  next,
) => next(args);

export default passthrough;

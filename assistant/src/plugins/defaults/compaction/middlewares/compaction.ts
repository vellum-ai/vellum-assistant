import type {
  CompactionArgs,
  CompactionResult,
  Middleware,
} from "../../../types.js";

/**
 * Passthrough middleware for the `compaction` pipeline. Forwards to
 * `next(args)` so any custom plugins layered outside still run; when this is
 * the only middleware, `next` is the terminal handler (`../terminal.ts`) and
 * returns the real compaction output.
 *
 * Defaults register at the OUTERMOST onion position, so deciding here without
 * calling `next` would shadow every later-registered plugin. Routing through
 * `next(args)` lets user middleware participate normally.
 */
const defaultCompactionMiddleware: Middleware<
  CompactionArgs,
  CompactionResult
> = async function defaultCompaction(args, next, ctx) {
  void ctx;
  return next(args);
};

export default defaultCompactionMiddleware;

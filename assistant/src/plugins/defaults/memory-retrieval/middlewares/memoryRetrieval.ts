import type { MemoryArgs, MemoryResult, Middleware } from "../../../types.js";

/**
 * Passthrough middleware for the `memoryRetrieval` pipeline.
 *
 * Keeping a real middleware registered (rather than an empty list) makes the
 * pipeline observable in `plugin.pipeline` logs with a non-empty `chain` field
 * and lets third-party plugins rely on the default slot being present even
 * when nothing is overriding it. The work happens in the terminal supplied by
 * the agent loop, which calls `runDefaultMemoryRetrieval`.
 */
const defaultMemoryRetrievalMiddleware: Middleware<MemoryArgs, MemoryResult> =
  async function defaultMemoryRetrieval(args, next) {
    return next(args);
  };

export default defaultMemoryRetrievalMiddleware;

import type {
  Middleware,
  ToolErrorArgs,
  ToolErrorDecision,
} from "../../../types.js";

/**
 * Passthrough middleware for the `toolError` pipeline. Forwards to `next(args)`
 * so later-registered user plugins still participate in the onion chain; the
 * actual nudge-decision logic lives in the terminal handler (`../terminal.ts`),
 * wired in at the `runPipeline` call site in `agent/loop.ts`.
 *
 * Named explicitly so the pipeline's structured log record carries
 * `"defaultToolErrorMiddleware"` in `chain` instead of an anonymous entry.
 */
const defaultToolErrorMiddleware: Middleware<ToolErrorArgs, ToolErrorDecision> =
  async function defaultToolErrorMiddleware(args, next) {
    return next(args);
  };

export default defaultToolErrorMiddleware;

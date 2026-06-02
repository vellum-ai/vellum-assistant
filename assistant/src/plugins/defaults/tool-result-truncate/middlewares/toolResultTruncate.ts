import type { Middleware } from "../../../types.js";
import type {
  ToolResultTruncateArgs,
  ToolResultTruncateResult,
} from "../types.js";

/**
 * Passthrough middleware for the `toolResultTruncate` pipeline. Forwards to
 * `next(args)` unchanged; the actual truncation lives in the terminal handler
 * (`../terminal.ts`), wired in at the `runPipeline` call site in
 * `agent/loop.ts`.
 *
 * Defaults register at the OUTERMOST onion position, so deciding here without
 * calling `next` would shadow every later-registered plugin (including
 * hot-reloaded ones). Routing through `next(args)` lets user middleware
 * participate normally.
 */
const passthrough: Middleware<
  ToolResultTruncateArgs,
  ToolResultTruncateResult
> = async (args, next) => next(args);

export default passthrough;

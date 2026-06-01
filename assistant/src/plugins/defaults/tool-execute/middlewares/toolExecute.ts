import type {
  Middleware,
  ToolExecuteArgs,
  ToolExecuteResult,
} from "../../../types.js";

/**
 * Passthrough middleware for the `toolExecute` pipeline. Forwards to
 * `next(args)` and returns the downstream result unchanged. The original
 * `ToolExecutor.execute` behavior runs in the terminal bound at the call site,
 * so this default makes the pipeline shape explicit without introducing any
 * behavior of its own: the chain `[defaultMiddleware] → terminal` composes
 * identically to `[] → terminal`.
 *
 * Named so the pipeline runner's `chain` log entry reads `defaultToolExecute`
 * instead of `anonymous`.
 */
const defaultToolExecute: Middleware<ToolExecuteArgs, ToolExecuteResult> =
  async function defaultToolExecute(args, next) {
    return next(args);
  };

export default defaultToolExecute;

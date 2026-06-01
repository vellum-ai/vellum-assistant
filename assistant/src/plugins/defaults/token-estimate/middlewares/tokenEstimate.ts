import type {
  EstimateArgs,
  EstimateResult,
  Middleware,
} from "../../../types.js";

/**
 * Passthrough middleware for the `tokenEstimate` pipeline. Forwards to
 * `next(args)` unchanged; the actual estimate lives in the terminal handler
 * (`../terminal.ts`), wired in at the `runPipeline` call sites in
 * `daemon/conversation-agent-loop.ts`.
 *
 * Defaults register at the OUTERMOST onion position, so deciding here without
 * calling `next` would shadow every later-registered plugin. The passthrough
 * lets user middleware that wraps the default (e.g. a doubler, a
 * provider-native `countTokens` override) participate normally.
 */
const passthrough: Middleware<EstimateArgs, EstimateResult> = async (
  args,
  next,
) => next(args);

export default passthrough;

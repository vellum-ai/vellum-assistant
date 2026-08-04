import { resolveModelIntent } from "../../../../providers/model-intents.js";

/**
 * Resolves the Gemini model used for media analysis. When no override is
 * supplied (the automatic background-processing path), defaults to the
 * catalog-backed vision intent so processing keeps working when a previously
 * pinned model is retired. Every consumer (execution and cache identity)
 * must resolve through this function so they agree on the default.
 */
export function resolveMediaAnalysisModel(model?: string): string {
  return model ?? resolveModelIntent("gemini", "vision-optimized");
}

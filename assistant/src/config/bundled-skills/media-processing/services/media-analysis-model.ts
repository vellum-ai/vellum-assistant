import { resolveModelIntent } from "../../../../providers/model-intents.js";

/**
 * Resolves the Gemini model used for media analysis. When no override is
 * supplied (the automatic background-processing path), the default comes
 * from the catalog-backed vision intent, which is validated against the
 * provider catalog at module load. Execution and cache identity must both
 * resolve through this function so they agree on the model.
 */
export function resolveMediaAnalysisModel(model?: string): string {
  return model ?? resolveModelIntent("gemini", "vision-optimized");
}

import { getModelsForProvider } from "@/assistant/llm-model-catalog";
import type { ProviderConnection } from "@/generated/daemon/types.gen";

/**
 * Resolve a model id to its human-facing display name.
 *
 * The static catalog covers first-party providers; openai-compatible models
 * live on the connection rows, so fall back to those. Unknown ids degrade to
 * the id itself with common path prefixes stripped (`accounts/../llama-x` →
 * `llama-x`) so raw routing ids stay readable in lists.
 */
export function resolveModelDisplayName(
  provider: string | undefined,
  modelId: string,
  connections?: ProviderConnection[],
): string {
  if (provider) {
    const catalogMatch = getModelsForProvider(provider).find(
      (m) => m.id === modelId,
    );
    if (catalogMatch) {
      return catalogMatch.displayName;
    }
  }
  for (const conn of connections ?? []) {
    const match = (conn.models ?? []).find((m) => m.id === modelId);
    if (match) {
      return match.displayName ?? match.id;
    }
  }
  const lastSlash = modelId.lastIndexOf("/");
  return lastSlash >= 0 ? modelId.slice(lastSlash + 1) : modelId;
}

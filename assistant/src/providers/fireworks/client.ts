import { PROVIDER_CATALOG } from "../model-catalog.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";

export interface FireworksProviderOptions {
  apiKey?: string;
  baseURL?: string;
  streamTimeoutMs?: number;
}

const DEFAULT_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

const FIREWORKS_MODEL_EFFORT_CEILINGS: ReadonlyMap<
  string,
  "high" | "xhigh" | "max"
> = new Map(
  PROVIDER_CATALOG.find((p) => p.id === "fireworks")?.models.flatMap((m) =>
    m.maxEffort ? ([[m.id, m.maxEffort]] as const) : [],
  ) ?? [],
);

export class FireworksProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: FireworksProviderOptions = {},
  ) {
    super(apiKey, model, {
      baseURL: options.baseURL?.trim() || DEFAULT_FIREWORKS_BASE_URL,
      providerName: "fireworks",
      providerLabel: "Fireworks",
      streamTimeoutMs: options.streamTimeoutMs,
      // Fallback for models not declared in the catalog. Most Fireworks
      // chat-completions models only document `low|medium|high`; per-model
      // overrides (e.g. DeepSeek V4 → "max") come from
      // {@link resolveMaxReasoningEffort}.
      maxReasoningEffort: "high",
      assistantReasoningField: "reasoning_content",
      // minimax-m3's function-call serialization collapses object-typed tool
      // args to `{}` on the wire; present them as JSON strings and decode back.
      coerceObjectArgsToJsonString: /minimax/i.test(model),
    });
  }

  protected override resolveMaxReasoningEffort(
    model: string,
  ): "high" | "xhigh" | "max" {
    return FIREWORKS_MODEL_EFFORT_CEILINGS.get(model) ?? "high";
  }
}

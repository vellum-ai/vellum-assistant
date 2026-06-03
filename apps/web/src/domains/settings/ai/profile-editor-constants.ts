import { MODELS_BY_PROVIDER } from "@/assistant/llm-model-catalog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProfileStatus = "active" | "disabled";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ALL_PROVIDERS = Object.keys(MODELS_BY_PROVIDER) as (keyof typeof MODELS_BY_PROVIDER)[];
export const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible";

export const CODEX_SUBSCRIPTION_MODEL_IDS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
]);

/**
 * Single source of truth for the image generation model catalog.
 *
 * Concrete model IDs change as providers ship new versions. Everything that
 * needs a model name (config schema default, skill executor, CLI help text)
 * imports from here so a version bump is a one-line change. User-facing
 * surfaces (SKILL.md, tool descriptions) reference the stable tier aliases
 * instead of concrete IDs.
 *
 * This module is intentionally dependency-free so the config schema layer
 * can import it without cycles.
 */

export type ImageModelProvider = "gemini" | "openai";

export interface ImageModelEntry {
  /** Concrete provider model ID sent on the API request. */
  id: string;
  provider: ImageModelProvider;
  /** Stable tier alias referenced by SKILL.md and tool callers. */
  alias: string;
  /** Human-readable label for help text and error messages. */
  label: string;
}

export const IMAGE_MODELS: readonly ImageModelEntry[] = [
  {
    id: "gemini-3.1-flash-image-preview",
    provider: "gemini",
    alias: "fast",
    label: "Nano Banana 2",
  },
  {
    id: "gemini-3-pro-image-preview",
    provider: "gemini",
    alias: "quality",
    label: "Nano Banana Pro",
  },
  {
    id: "gpt-image-2",
    provider: "openai",
    alias: "openai",
    label: "GPT Image 2",
  },
] as const;

export const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[0].id;

/**
 * Resolve a model input (tier alias or concrete ID) to a registry entry.
 * Returns undefined for unknown values so callers can produce an error that
 * lists the currently available models.
 */
export function resolveImageModel(model: string): ImageModelEntry | undefined {
  return IMAGE_MODELS.find((m) => m.alias === model || m.id === model);
}

const OPENROUTER_VENDOR_PREFIX: Record<ImageModelProvider, string> = {
  gemini: "google",
  openai: "openai",
};

export const DEFAULT_OPENROUTER_IMAGE_MODEL =
  "google/gemini-3.1-flash-image-preview";

/**
 * Qualify a built-in alias or concrete ID for OpenRouter's Images API.
 * Unknown values are returned trimmed so live catalog slugs pass through.
 */
export function qualifyImageModelForOpenRouter(model: string): string {
  const trimmed = model.trim();
  const entry = resolveImageModel(trimmed);
  if (!entry) {
    return trimmed;
  }
  return `${OPENROUTER_VENDOR_PREFIX[entry.provider]}/${entry.id}`;
}

/**
 * Resolve a caller-supplied image model against the configured provider.
 *
 * OpenRouter accepts any trimmed slug from its live catalog. Built-in
 * aliases and bare IDs are qualified (`fast` ->
 * `google/gemini-3.1-flash-image-preview`). Gemini, OpenAI, and Vellum
 * still require a registry match.
 */
export function resolveRequestedImageModel(
  model: unknown,
  configuredProvider: string,
): { model?: string; error?: string } {
  if (typeof model !== "string" || !model) {
    return {};
  }
  const trimmed = model.trim();
  if (!trimmed) {
    return {};
  }
  if (configuredProvider === "openrouter") {
    return { model: qualifyImageModelForOpenRouter(trimmed) };
  }
  const entry = resolveImageModel(trimmed);
  if (!entry) {
    return {
      error: `Unknown model "${trimmed}". Available models and aliases:\n${describeImageModels()}`,
    };
  }
  return { model: entry.id };
}

/**
 * One line per model: "alias -> id (label)". Used in CLI help text and in
 * unknown-model error messages so the available set is always current.
 */
export function describeImageModels(): string {
  return IMAGE_MODELS.map((m) => `  ${m.alias} -> ${m.id} (${m.label})`).join(
    "\n",
  );
}

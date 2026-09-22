import {
  getModelsForProvider,
  parseVellumRoutedModel,
} from "@/assistant/llm-model-catalog";

/**
 * Modalities the editor can declare. Image and audio have send-path
 * enforcement; text is always sent and video is still converted to a file
 * note, so those rows are not configurable here.
 */
export const INPUT_MODALITIES = ["image", "audio"] as const;
export type InputModality = (typeof INPUT_MODALITIES)[number];

export type ModalityOverride = {
  enabled?: boolean;
  supported?: boolean;
};

export type InputModalities = Partial<Record<InputModality, ModalityOverride>>;

/**
 * Modalities are configurable when the model id is not a code-owned catalog
 * entry: empty-catalog providers (openai-compatible, litellm, opencode) and
 * free-text ids on catalog providers.
 */
export function profileUsesFreeTextModel(
  provider: string,
  model: string,
): boolean {
  if (provider === "" || model === "") {
    return false;
  }
  const catalog = getModelsForProvider(provider);
  if (catalog.length === 0) {
    return true;
  }
  const catalogId =
    provider === "vellum"
      ? (parseVellumRoutedModel(model)?.model ?? model)
      : model;
  return !catalog.some((entry) => entry.id === catalogId);
}

export function catalogSupportedForFreeText(modality: InputModality): boolean {
  switch (modality) {
    case "image":
    case "audio":
      return false;
  }
}

export function modalityEnabled(
  modality: InputModality,
  override: ModalityOverride | undefined,
): boolean {
  return override?.enabled ?? catalogSupportedForFreeText(modality);
}

export function modalitySupported(
  modality: InputModality,
  override: ModalityOverride | undefined,
  enabled: boolean,
): boolean {
  const catalog = catalogSupportedForFreeText(modality);
  if (!enabled) {
    return catalog;
  }
  return override?.supported ?? catalog;
}

export function parseInputModalities(value: unknown): InputModalities {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const source = value as Record<string, unknown>;
  const parsed: InputModalities = {};
  for (const modality of INPUT_MODALITIES) {
    const row = source[modality];
    if (row == null || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const override: ModalityOverride = {};
    if (typeof record.enabled === "boolean") {
      override.enabled = record.enabled;
    }
    if (typeof record.supported === "boolean") {
      override.supported = record.supported;
    }
    if (override.enabled !== undefined || override.supported !== undefined) {
      parsed[modality] = override;
    }
  }
  return parsed;
}

/**
 * Persist only rows that differ from the free-text defaults (image and
 * audio off). Returns `null` when every row is default so an edit can clear
 * a previously stored override.
 */
export function serializeInputModalities(
  state: InputModalities,
): InputModalities | null {
  const out: InputModalities = {};
  let any = false;
  for (const modality of INPUT_MODALITIES) {
    const enabled = modalityEnabled(modality, state[modality]);
    const supported = modalitySupported(modality, state[modality], enabled);
    const catalog = catalogSupportedForFreeText(modality);
    if (!enabled && supported === catalog) {
      continue;
    }
    out[modality] = enabled
      ? { enabled: true, supported }
      : { enabled: false };
    any = true;
  }
  return any ? out : null;
}

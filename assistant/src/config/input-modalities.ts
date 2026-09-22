import { z } from "zod";

import { PROVIDER_CATALOG } from "../providers/model-catalog.js";

/**
 * Input modalities a profile can declare independently of the model catalog.
 * Cataloged models keep today's flags; free-text / empty-catalog models use
 * these overrides to say what the serving surface actually accepts.
 */
export const INPUT_MODALITIES = ["text", "image", "audio", "video"] as const;
export type InputModality = (typeof INPUT_MODALITIES)[number];

/**
 * Per-modality policy + capability. Absent fields inherit catalog defaults
 * (unknown models: unsupported, except text which is always supported).
 *
 * - `enabled`: whether this profile may use the modality.
 * - `supported`: whether the model accepts the modality, overriding the catalog
 *   when set.
 */
export const ModalityOverrideSchema = z
  .object({
    enabled: z.boolean().optional(),
    supported: z.boolean().optional(),
  })
  .meta({ id: "ModalityOverride" });
export type ModalityOverride = z.infer<typeof ModalityOverrideSchema>;

export const InputModalitiesSchema = z
  .object({
    text: ModalityOverrideSchema.optional(),
    image: ModalityOverrideSchema.optional(),
    audio: ModalityOverrideSchema.optional(),
    video: ModalityOverrideSchema.optional(),
  })
  .meta({ id: "InputModalities" });
export type InputModalities = z.infer<typeof InputModalitiesSchema>;

/**
 * Catalog capability for a modality. Unknown models fail closed except text,
 * which every chat profile can send.
 */
export function catalogSupportsModality(
  modality: InputModality,
  catalog: {
    supportsVision?: boolean;
    supportsAudioInput?: boolean;
  } | undefined,
): boolean {
  if (modality === "text") {
    return true;
  }
  if (modality === "image") {
    return catalog?.supportsVision === true;
  }
  if (modality === "audio") {
    return catalog?.supportsAudioInput === true;
  }
  return false;
}

export function catalogEntryFor(
  provider: string,
  model: string,
): { supportsVision?: boolean; supportsAudioInput?: boolean } | undefined {
  const catalogProvider = PROVIDER_CATALOG.find((p) => p.id === provider);
  return catalogProvider?.models.find((m) => m.id === model);
}

/**
 * Resolve whether a modality should be sent on the wire.
 *
 * Untouched (no override for that row) inherits `catalogSupported`, which may
 * be `undefined` when the catalog does not know the model. An authored
 * override is always a boolean: both `enabled` and `supported` must be true,
 * with missing leaves defaulting to enabled=true and supported=catalog.
 */
export function resolveModalityOverride(
  override: ModalityOverride | undefined,
  catalogSupported: boolean | undefined,
): boolean | undefined {
  if (override == null) {
    return catalogSupported;
  }
  const catalog = catalogSupported === true;
  const enabled = override.enabled ?? true;
  const supported = override.supported ?? catalog;
  return enabled && supported;
}

export function modalitiesOf(
  entry: { inputModalities?: InputModalities | null } | undefined,
): InputModalities | undefined {
  return entry?.inputModalities ?? undefined;
}

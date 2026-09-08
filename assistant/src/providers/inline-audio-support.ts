import { resolveModalityOverride } from "../config/input-modalities.js";
import { getConfig } from "../config/loader.js";
import { modelSupportsAudioInput } from "./model-catalog.js";

/**
 * Whether eligible audio attachments should be sent inline as `input_audio`
 * for this model id. Catalog `supportsAudioInput` wins when the model is
 * known; otherwise any profile bound to the same model id that declares
 * audio enabled and supported opts the send path in.
 */
export function requestSupportsInlineAudio(modelId: string): boolean {
  if (modelSupportsAudioInput(modelId)) {
    return true;
  }
  const profiles = getConfig().llm.profiles ?? {};
  for (const entry of Object.values(profiles)) {
    if (entry?.model !== modelId) {
      continue;
    }
    if (
      resolveModalityOverride(entry.inputModalities?.audio, false) === true
    ) {
      return true;
    }
  }
  return false;
}

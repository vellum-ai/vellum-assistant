/**
 * Pure recipe edits and slider mappings for the Debug tone lab.
 */

import {
  defaultToneLayer,
  TONE_LIMITS,
  type ToneLayer,
  type ToneRecipe,
} from "@/lib/sounds/tone-synth";

/** Resolution of a log-scaled slider's 0..N track. */
export const LOG_SLIDER_STEPS = 1000;

/**
 * Map a frequency onto a 0..{@link LOG_SLIDER_STEPS} track so each octave gets
 * equal travel, instead of the top octave taking half the slider.
 */
export function toLogSlider(
  value: number,
  range: { min: number; max: number },
): number {
  const ratio = Math.log(value / range.min) / Math.log(range.max / range.min);
  return Math.round(Math.min(1, Math.max(0, ratio)) * LOG_SLIDER_STEPS);
}

export function fromLogSlider(
  position: number,
  range: { min: number; max: number },
): number {
  const ratio = position / LOG_SLIDER_STEPS;
  const value = range.min * Math.pow(range.max / range.min, ratio);
  return Math.round(value * 100) / 100;
}

export function updateLayer(
  recipe: ToneRecipe,
  index: number,
  patch: Partial<ToneLayer>,
): ToneRecipe {
  return {
    ...recipe,
    layers: recipe.layers.map((layer, i) => {
      if (i !== index) {
        return layer;
      }
      const next = { ...layer, ...patch };
      // A layer with no glide keeps tracking its pitch, so moving the pitch
      // slider does not silently introduce a sweep back to the old note.
      if (
        patch.frequency !== undefined &&
        patch.glideTo === undefined &&
        layer.glideTo === layer.frequency
      ) {
        next.glideTo = patch.frequency;
      }
      return next;
    }),
  };
}

export function canAddLayer(recipe: ToneRecipe): boolean {
  return recipe.layers.length < TONE_LIMITS.layers.max;
}

/** Append a layer that starts where the current tone's last layer peaks. */
export function addLayer(recipe: ToneRecipe): ToneRecipe {
  if (!canAddLayer(recipe)) {
    return recipe;
  }
  const last = recipe.layers.at(-1);
  const layer = defaultToneLayer();
  if (last) {
    layer.startMs = Math.min(
      TONE_LIMITS.startMs.max,
      last.startMs + last.attackMs + 80,
    );
  }
  return { ...recipe, layers: [...recipe.layers, layer] };
}

export function duplicateLayer(recipe: ToneRecipe, index: number): ToneRecipe {
  const source = recipe.layers[index];
  if (!source || !canAddLayer(recipe)) {
    return recipe;
  }
  const layers = [...recipe.layers];
  layers.splice(index + 1, 0, { ...source });
  return { ...recipe, layers };
}

/** Remove a layer; the last remaining layer cannot be removed. */
export function removeLayer(recipe: ToneRecipe, index: number): ToneRecipe {
  if (recipe.layers.length <= 1) {
    return recipe;
  }
  return { ...recipe, layers: recipe.layers.filter((_, i) => i !== index) };
}

export function recipesEqual(a: ToneRecipe, b: ToneRecipe): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

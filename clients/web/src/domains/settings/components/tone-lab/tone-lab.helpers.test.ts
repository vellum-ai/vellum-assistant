import { describe, expect, test } from "bun:test";

import {
  addLayer,
  duplicateLayer,
  fromLogSlider,
  LOG_SLIDER_STEPS,
  removeLayer,
  toLogSlider,
  updateLayer,
} from "@/domains/settings/components/tone-lab/tone-lab.helpers";
import { TONE_PRESETS } from "@/lib/sounds/tone-presets";
import { TONE_LIMITS, type ToneRecipe } from "@/lib/sounds/tone-synth";

const range = TONE_LIMITS.frequency;

function withLayers(count: number): ToneRecipe {
  const base = TONE_PRESETS.doubleBlip;
  const layer = base.layers[0]!;
  return {
    ...base,
    layers: Array.from({ length: count }, () => ({ ...layer })),
  };
}

describe("log slider", () => {
  test("maps the range ends to the track ends", () => {
    expect(toLogSlider(range.min, range)).toBe(0);
    expect(toLogSlider(range.max, range)).toBe(LOG_SLIDER_STEPS);
    expect(fromLogSlider(0, range)).toBe(range.min);
    expect(fromLogSlider(LOG_SLIDER_STEPS, range)).toBe(range.max);
  });

  test("round-trips a frequency closely", () => {
    const hz = fromLogSlider(toLogSlider(440, range), range);
    expect(Math.abs(hz - 440) / 440).toBeLessThan(0.01);
  });
});

describe("updateLayer", () => {
  test("carries an unglided layer's glide along with its pitch", () => {
    const next = updateLayer(withLayers(1), 0, { frequency: 300 });
    expect(next.layers[0]?.glideTo).toBe(300);
  });

  test("leaves a deliberate glide alone", () => {
    const recipe = updateLayer(withLayers(1), 0, { glideTo: 1500 });
    const next = updateLayer(recipe, 0, { frequency: 300 });
    expect(next.layers[0]?.glideTo).toBe(1500);
  });
});

describe("layer list edits", () => {
  test("adds and duplicates up to the layer cap", () => {
    const full = withLayers(TONE_LIMITS.layers.max);
    expect(addLayer(full)).toBe(full);
    expect(duplicateLayer(full, 0)).toBe(full);
    expect(addLayer(withLayers(1)).layers).toHaveLength(2);
    expect(duplicateLayer(withLayers(1), 0).layers).toHaveLength(2);
  });

  test("never removes the last layer", () => {
    const single = withLayers(1);
    expect(removeLayer(single, 0)).toBe(single);
    expect(removeLayer(withLayers(2), 1).layers).toHaveLength(1);
  });
});

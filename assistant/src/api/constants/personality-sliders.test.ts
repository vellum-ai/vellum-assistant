import { describe, expect, test } from "bun:test";

import {
  PERSONALITY_AXIS_IDS,
  PERSONALITY_DIRECTION_AXES,
  PERSONALITY_SLIDER_DEFAULT,
  PERSONALITY_SLIDERS_PATH,
} from "./personality-sliders.js";

describe("personality slider contract", () => {
  test("sidecar path and default stay centered", () => {
    expect(PERSONALITY_SLIDERS_PATH).toBe("data/personality-sliders.json");
    expect(PERSONALITY_SLIDER_DEFAULT).toBe(50);
  });

  test("every slider axis has a left and right direction pole", () => {
    expect(PERSONALITY_DIRECTION_AXES.map((axis) => axis.sliderId)).toEqual(
      Object.values(PERSONALITY_AXIS_IDS),
    );
  });
});

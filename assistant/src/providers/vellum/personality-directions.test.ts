import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  HOSTED_STEERING_MODEL,
  hostedDirectionsExtraBody,
  mapPersonalitySlidersToDirections,
  parsePersonalitySliderSidecar,
  PERSONALITY_SLIDERS_PATH,
  readPersonalitySliderSidecar,
  resolveHostedDirections,
} from "./personality-directions.js";

function sliders(overrides: Record<string, number>): Record<string, number> {
  return {
    "companion-coworker": 50,
    "genz-boomer": 50,
    "execute-collaborate": 50,
    "playful-serious": 50,
    "polite-unfiltered": 50,
    ...overrides,
  };
}

describe("mapPersonalitySlidersToDirections", () => {
  test("center and omitted values produce no directions", () => {
    expect(mapPersonalitySlidersToDirections(undefined)).toBeUndefined();
    expect(mapPersonalitySlidersToDirections(null)).toBeUndefined();
    expect(mapPersonalitySlidersToDirections(sliders({}))).toBeUndefined();
    expect(
      mapPersonalitySlidersToDirections(sliders({ "companion-coworker": 50 })),
    ).toBeUndefined();
  });

  test("maps 0 / 25 / 75 / 100 onto one-sided alphas", () => {
    expect(
      mapPersonalitySlidersToDirections(sliders({ "companion-coworker": 0 })),
    ).toEqual({ companion: 1 });
    expect(
      mapPersonalitySlidersToDirections(sliders({ "companion-coworker": 25 })),
    ).toEqual({ companion: 0.5 });
    expect(
      mapPersonalitySlidersToDirections(sliders({ "companion-coworker": 75 })),
    ).toEqual({ coworker: 0.5 });
    expect(
      mapPersonalitySlidersToDirections(sliders({ "companion-coworker": 100 })),
    ).toEqual({ coworker: 1 });
  });

  test("maps each axis onto its left or right pole", () => {
    expect(
      mapPersonalitySlidersToDirections(
        sliders({
          "companion-coworker": 0,
          "genz-boomer": 100,
          "execute-collaborate": 25,
          "playful-serious": 75,
          "polite-unfiltered": 0,
        }),
      ),
    ).toEqual({
      companion: 1,
      boomer: 1,
      independent: 0.5,
      serious: 0.5,
      polite: 1,
    });
  });

  test("clamps out-of-range sliders and ignores non-finite values", () => {
    expect(
      mapPersonalitySlidersToDirections(
        sliders({
          "companion-coworker": -20,
          "genz-boomer": 140,
          "playful-serious": Number.NaN,
        }),
      ),
    ).toEqual({ companion: 1, boomer: 1 });
  });

  test("ignores unknown slider ids", () => {
    expect(
      mapPersonalitySlidersToDirections(
        sliders({ "not-an-axis": 0, "companion-coworker": 25 }),
      ),
    ).toEqual({ companion: 0.5 });
  });
});

describe("resolveHostedDirections", () => {
  test("attaches directions only for the hosted Qwen snapshot", () => {
    const values = sliders({ "companion-coworker": 0 });
    expect(
      resolveHostedDirections({
        model: HOSTED_STEERING_MODEL,
        sliders: values,
      }),
    ).toEqual({ companion: 1 });
    expect(
      resolveHostedDirections({
        model: "claude-opus-4-8",
        sliders: values,
      }),
    ).toBeUndefined();
    expect(
      resolveHostedDirections({
        model: HOSTED_STEERING_MODEL,
        sliders: sliders({}),
      }),
    ).toBeUndefined();
  });
});

describe("personality slider sidecar", () => {
  test("parses a valid sidecar and rejects malformed payloads", () => {
    expect(
      parsePersonalitySliderSidecar(
        JSON.stringify({ "companion-coworker": 25, extra: "nope" }),
      ),
    ).toEqual({ "companion-coworker": 25 });
    expect(parsePersonalitySliderSidecar("not-json")).toBeNull();
    expect(parsePersonalitySliderSidecar("[]")).toBeNull();
  });

  test("reads data/personality-sliders.json from the workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "personality-sliders-"));
    mkdirSync(join(workspace, "data"));
    writeFileSync(
      join(workspace, PERSONALITY_SLIDERS_PATH),
      JSON.stringify({ "companion-coworker": 0 }),
    );
    expect(readPersonalitySliderSidecar(workspace)).toEqual({
      "companion-coworker": 0,
    });
    expect(readPersonalitySliderSidecar(join(workspace, "missing"))).toBeNull();
  });

  test("builds extraBody only for hosted Qwen with a nonzero sidecar", () => {
    const workspace = mkdtempSync(join(tmpdir(), "personality-extra-body-"));
    mkdirSync(join(workspace, "data"));
    writeFileSync(
      join(workspace, PERSONALITY_SLIDERS_PATH),
      JSON.stringify({ "companion-coworker": 25 }),
    );
    expect(hostedDirectionsExtraBody(HOSTED_STEERING_MODEL, workspace)).toEqual(
      {
        directions: { companion: 0.5 },
      },
    );
    expect(
      hostedDirectionsExtraBody("claude-opus-4-8", workspace),
    ).toBeUndefined();
    expect(
      hostedDirectionsExtraBody(
        HOSTED_STEERING_MODEL,
        join(workspace, "missing"),
      ),
    ).toBeUndefined();
  });
});

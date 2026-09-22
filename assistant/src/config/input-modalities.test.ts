import { describe, expect, test } from "bun:test";

import {
  catalogSupportsModality,
  resolveModalityOverride,
} from "./input-modalities.js";

describe("catalogSupportsModality", () => {
  test("text is always supported", () => {
    expect(catalogSupportsModality("text", undefined)).toBe(true);
    expect(catalogSupportsModality("text", { supportsVision: false })).toBe(
      true,
    );
  });

  test("image follows supportsVision and fails closed when unknown", () => {
    expect(catalogSupportsModality("image", undefined)).toBe(false);
    expect(catalogSupportsModality("image", { supportsVision: true })).toBe(
      true,
    );
    expect(catalogSupportsModality("image", { supportsVision: false })).toBe(
      false,
    );
  });

  test("audio follows supportsAudioInput and fails closed when unknown", () => {
    expect(catalogSupportsModality("audio", undefined)).toBe(false);
    expect(
      catalogSupportsModality("audio", { supportsAudioInput: true }),
    ).toBe(true);
  });

  test("video has no catalog flag and fails closed", () => {
    expect(
      catalogSupportsModality("video", {
        supportsVision: true,
        supportsAudioInput: true,
      }),
    ).toBe(false);
  });
});

describe("resolveModalityOverride", () => {
  test("untouched inherits the catalog value, including unknown", () => {
    expect(resolveModalityOverride(undefined, true)).toBe(true);
    expect(resolveModalityOverride(undefined, false)).toBe(false);
    expect(resolveModalityOverride(undefined, undefined)).toBeUndefined();
  });

  test("enabled and supported together reach the wire even when the catalog is unknown", () => {
    expect(
      resolveModalityOverride({ enabled: true, supported: true }, undefined),
    ).toBe(true);
  });

  test("enabled without a support declaration inherits the catalog", () => {
    expect(resolveModalityOverride({ enabled: true }, false)).toBe(false);
    expect(resolveModalityOverride({ enabled: true }, undefined)).toBe(false);
    expect(resolveModalityOverride({ enabled: true }, true)).toBe(true);
  });

  test("disabled policy blocks a catalog-supported modality", () => {
    expect(
      resolveModalityOverride({ enabled: false, supported: true }, true),
    ).toBe(false);
  });

  test("supported: true without enabled defaults enabled to true", () => {
    expect(resolveModalityOverride({ supported: true }, false)).toBe(true);
  });
});

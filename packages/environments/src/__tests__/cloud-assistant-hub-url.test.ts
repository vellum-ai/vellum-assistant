/**
 * Pins the environment-to-cloud-hub mapping in one place. Both consumers
 * (the Capacitor shell's `server.url` and the CLI remote-web edge's
 * `hubUrl`) read this helper, so this matrix is the single behavioral pin
 * for the served URLs.
 */

import { describe, expect, test } from "bun:test";

import { cloudAssistantHubUrl, SEEDS } from "../index.js";

describe("cloudAssistantHubUrl", () => {
  test("cloud environments resolve to their own web origin", () => {
    expect(cloudAssistantHubUrl("production")).toBe(
      "https://www.vellum.ai/assistant",
    );
    expect(cloudAssistantHubUrl("staging")).toBe(
      "https://staging-assistant.vellum.ai/assistant",
    );
  });

  test("every other environment falls back to the dev SPA", () => {
    for (const name of ["dev", "test", "local", "unknown-env", undefined]) {
      expect(cloudAssistantHubUrl(name)).toBe(
        "https://dev-assistant.vellum.ai/assistant",
      );
    }
  });

  test("cloud hub URLs derive from the seed web URLs", () => {
    for (const name of ["production", "staging"]) {
      expect(cloudAssistantHubUrl(name)).toBe(
        `${SEEDS[name].webUrl}/assistant`,
      );
    }
    expect(cloudAssistantHubUrl("local")).toBe(`${SEEDS.dev.webUrl}/assistant`);
  });
});

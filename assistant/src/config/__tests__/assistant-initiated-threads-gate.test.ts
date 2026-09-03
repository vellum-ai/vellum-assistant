/**
 * The gate reads a string-valued flag that does not always arrive as a
 * string.
 *
 * The registry and the gateway's persisted store carry the declared `"on"` /
 * `"off"` strings. The gateway's env-override path does not: its parser
 * (`feature-flag-env-overrides.ts`) treats `on` as a truthy *word* and
 * coerces it to boolean `true`, then applies env overrides last — so
 * `VELLUM_FLAG_ASSISTANT_INITIATED_THREADS=on` reaches the daemon as `true`.
 *
 * A strict `=== "on"` therefore read the documented env kill-switch as OFF,
 * and did it silently: the section just never rendered. That shipped in the
 * first cut of this gate and cost an afternoon of QA, which is why both
 * shapes are pinned here rather than only the one the registry emits.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

let flagValue: boolean | string = "off";

mock.module("../assistant-feature-flags.js", () => ({
  getAssistantFeatureFlagValue: () => flagValue,
}));

const { isAssistantInitiatedThreadsEnabled } = await import(
  "../assistant-initiated-threads-gate.js"
);

afterEach(() => {
  flagValue = "off";
});

describe("isAssistantInitiatedThreadsEnabled", () => {
  test('enabled by the declared string "on" (registry / persisted store)', () => {
    flagValue = "on";
    expect(isAssistantInitiatedThreadsEnabled()).toBe(true);
  });

  test("enabled by boolean true (the gateway's env-override coercion)", () => {
    // The regression. `VELLUM_FLAG_ASSISTANT_INITIATED_THREADS=on` arrives
    // here as `true`, never as "on".
    flagValue = true;
    expect(isAssistantInitiatedThreadsEnabled()).toBe(true);
  });

  test('disabled by the declared string "off"', () => {
    flagValue = "off";
    expect(isAssistantInitiatedThreadsEnabled()).toBe(false);
  });

  test("disabled by boolean false (env `=off` coercion)", () => {
    flagValue = false;
    expect(isAssistantInitiatedThreadsEnabled()).toBe(false);
  });

  test("fails closed on an unrecognized arm", () => {
    // A future A/B value this gate has no opinion about must not read as on.
    flagValue = "variant-b";
    expect(isAssistantInitiatedThreadsEnabled()).toBe(false);
  });
});

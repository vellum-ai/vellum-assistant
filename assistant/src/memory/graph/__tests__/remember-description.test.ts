import { beforeEach, describe, expect, mock, test } from "bun:test";

let flagEnabled = false;

mock.module("../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (_key: string, _config: unknown) =>
    flagEnabled,
}));

import { getRememberDescription } from "../tools.js";

const stubConfig = {} as unknown as Parameters<
  typeof getRememberDescription
>[0];

describe("getRememberDescription", () => {
  beforeEach(() => {
    flagEnabled = false;
  });

  test("flag off — returns the default high-pressure description", () => {
    const desc = getRememberDescription(stubConfig);
    expect(desc).toContain("**CRITICAL:**");
    expect(desc).toContain("most frequently used tool");
    expect(desc).toContain("almost every turn");
  });

  test("flag on — returns the relaxed judgment-framing description", () => {
    flagEnabled = true;
    const desc = getRememberDescription(stubConfig);
    expect(desc).not.toContain("**CRITICAL:**");
    expect(desc).not.toContain("almost every turn");
    expect(desc).toContain("a retrospective pass");
    expect(desc).toContain("Use judgment");
  });

  test("the two variants differ", () => {
    flagEnabled = false;
    const off = getRememberDescription(stubConfig);
    flagEnabled = true;
    const on = getRememberDescription(stubConfig);
    expect(off).not.toBe(on);
  });

  test("corrections-are-priority language is preserved in BOTH variants", () => {
    flagEnabled = false;
    expect(getRememberDescription(stubConfig)).toMatch(
      /Corrections are.*highest priority/i,
    );
    flagEnabled = true;
    expect(getRememberDescription(stubConfig)).toMatch(
      /Corrections are.*highest priority/i,
    );
  });
});

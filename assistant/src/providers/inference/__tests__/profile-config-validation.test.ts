import { describe, expect, test } from "bun:test";

import { validateInferenceProfileConfig } from "../../../api/constants/profile-config-validation.js";

describe("validateInferenceProfileConfig", () => {
  test("rejects an output budget that consumes the whole context window", () => {
    const issue = validateInferenceProfileConfig({
      maxTokens: 300000,
      modelContextWindowTokens: 300000,
    });
    expect(issue?.field).toBe("maxTokens");
    expect(issue?.message).toContain("context window");
  });

  test("passes an output budget that leaves input room", () => {
    expect(
      validateInferenceProfileConfig({
        maxTokens: 8000,
        modelContextWindowTokens: 300000,
      }),
    ).toBeNull();
  });

  test("rejects an output budget over the model's output cap", () => {
    const issue = validateInferenceProfileConfig({
      maxTokens: 100000,
      modelMaxOutputTokens: 64000,
      modelContextWindowTokens: 200000,
    });
    expect(issue?.message).toContain("maximum output");
  });

  test("silent when either side of the judgment is unknown", () => {
    expect(validateInferenceProfileConfig({ maxTokens: 300000 })).toBeNull();
    expect(
      validateInferenceProfileConfig({ modelContextWindowTokens: 300000 }),
    ).toBeNull();
  });
});

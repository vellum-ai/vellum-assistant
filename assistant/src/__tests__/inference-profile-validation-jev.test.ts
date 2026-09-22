import { beforeEach, describe, expect, test } from "bun:test";

import { validateInferenceProfileKey } from "../config/inference-profile-validation.js";
import { setConfig } from "./helpers/set-config.js";

describe("validateInferenceProfileKey and the managed Jev profile", () => {
  beforeEach(() => {
    setConfig("llm", { profiles: {} });
  });

  test("a schedule or subagent turn cannot run on the verdict model", () => {
    expect(validateInferenceProfileKey("balanced")).toBeNull();
    expect(validateInferenceProfileKey("jev-managed")).toContain(
      "is not defined in llm.profiles",
    );
  });
});

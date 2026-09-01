import { describe, expect, test } from "bun:test";

import {
  DO_NOT_SHOW_CREDENTIALS_CLI,
  securePromptGuidance,
} from "../secure-prompt-guidance.js";

describe("securePromptGuidance", () => {
  test("names the service and field without a CLI argv", () => {
    const text = securePromptGuidance({
      service: "posthog",
      field: "personal_api_key",
    });
    expect(text).toContain("in-app secure prompt for posthog/personal_api_key");
    expect(text).toContain(DO_NOT_SHOW_CREDENTIALS_CLI);
    expect(text).not.toContain("credentials prompt");
    expect(text).not.toContain("--service");
  });

  test("names a service alone when no field is given", () => {
    expect(securePromptGuidance({ service: "gemini" })).toContain(
      "in-app secure prompt for gemini.",
    );
  });

  test("uses Re-collect when asked", () => {
    expect(securePromptGuidance({ verb: "Re-collect" })).toMatch(
      /^Re-collect it through the in-app secure prompt\./,
    );
  });

  test("lowercases the verb for mid-sentence use", () => {
    expect(
      securePromptGuidance({
        service: "elevenlabs",
        field: "api_key",
        capitalize: false,
      }),
    ).toMatch(/^collect it through the in-app secure prompt/);
  });
});

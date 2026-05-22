import { describe, expect, test } from "bun:test";

import { maskSecretForDisplay } from "@/domains/settings/ai/secret-mask.js";

describe("AI settings secret masking", () => {
  test("matches the masked key format shown after saving a web search API key", () => {
    expect(maskSecretForDisplay("BSA-test-key-1234567890")).toBe(
      "BSA-test-k...7890",
    );
  });
});

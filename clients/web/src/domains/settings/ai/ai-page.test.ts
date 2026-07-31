import { describe, expect, test } from "bun:test";

import {
  SAVED_SECRET_PLACEHOLDER,
  secretPlaceholder,
} from "@/domains/settings/ai/secret-placeholder";

describe("AI settings secret placeholders", () => {
  test("uses a password-style placeholder when a key is already saved", () => {
    expect(secretPlaceholder("pplx-...", true)).toBe(SAVED_SECRET_PLACEHOLDER);
  });

  test("uses the provider hint when no key is saved", () => {
    expect(secretPlaceholder("pplx-...", false)).toBe("pplx-...");
  });
});

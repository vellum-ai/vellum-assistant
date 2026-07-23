import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  registerPluginSecretPatterns,
  resetPluginSecretPatternsForTests,
  unregisterPluginSecretPatterns,
} from "../security/plugin-secret-patterns.js";
import { redactLogString } from "../util/log-redact.js";

describe("redactLogString", () => {
  test("redacts bearer tokens", () => {
    expect(redactLogString("Authorization: Bearer abc.def-123")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  test("redacts static prefix API keys", () => {
    const key = `ghp_${"A".repeat(36)}`;
    const result = redactLogString(`request with token ${key} failed`);
    expect(result).not.toContain(key);
    expect(result).toContain("[REDACTED]");
  });

  test("passes through strings without secrets", () => {
    const input = "plain log line with no credentials";
    expect(redactLogString(input)).toBe(input);
  });

  describe("plugin-declared patterns", () => {
    // Synthetic token mirroring the incident's shape (never a real credential).
    const pluginKey = "virlo_tkn_Qm7pW2xLbV9sKjR4tNcY8dZh3Fg";

    const registerVirlo = () =>
      registerPluginSecretPatterns("virlo", [
        { label: "Virlo API Key", pattern: "virlo_tkn_[A-Za-z0-9_-]{20,}" },
      ]);

    beforeEach(() => {
      resetPluginSecretPatternsForTests();
    });

    afterEach(() => {
      resetPluginSecretPatternsForTests();
    });

    test("masks a registered plugin key", () => {
      registerVirlo();
      expect(redactLogString(`request failed for ${pluginKey}`)).toBe(
        "request failed for [REDACTED]",
      );
    });

    test("does not mask before registration and stops after unregister", () => {
      const input = `request failed for ${pluginKey}`;
      expect(redactLogString(input)).toBe(input);

      registerVirlo();
      expect(redactLogString(input)).not.toContain(pluginKey);

      unregisterPluginSecretPatterns("virlo");
      expect(redactLogString(input)).toBe(input);
    });
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

describe("assistant feature flag defaults registry sync", () => {
  test("gateway bundled defaults copy matches canonical meta copy", () => {
    const repoRoot = join(process.cwd(), "..");
    const canonicalPath = join(repoRoot, "meta", "assistant-feature-flags", "assistant-feature-flag-defaults.json");
    const bundledPath = join(process.cwd(), "src", "assistant-feature-flag-defaults.json");

    const canonical = readFileSync(canonicalPath, "utf-8");
    const bundled = readFileSync(bundledPath, "utf-8");

    expect(bundled, [
      "The bundled copy at gateway/src/assistant-feature-flag-defaults.json",
      "is out of sync with the canonical copy at meta/assistant-feature-flags/assistant-feature-flag-defaults.json.",
      "",
      "To fix: copy the canonical file over the bundled one:",
      "  cp meta/assistant-feature-flags/assistant-feature-flag-defaults.json gateway/src/assistant-feature-flag-defaults.json",
    ].join("\n")).toBe(canonical);
  });
});

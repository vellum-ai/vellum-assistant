import { describe, expect, test } from "bun:test";

import { extractThemes } from "../influencer-theme-extract.js";

describe("extractThemes", () => {
  test("extracts multiple matching themes", () => {
    const themes = extractThemes(
      "Fitness coach sharing workout and nutrition plans",
      "health and wellness",
    );

    expect(themes).toContain("fitness");
    expect(themes).toContain("lifestyle");
  });
});

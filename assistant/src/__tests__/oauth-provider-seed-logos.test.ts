import { describe, expect, test } from "bun:test";

import { PROVIDER_SEED_DATA } from "../oauth/seed-providers.js";

/**
 * Allowed CDN prefixes for ``logoUrl``. Mirrors the source registry in
 * ``clients/shared/Resources/integration-logos-manifest.json``:
 *
 * - Simple Icons (CC0) is the default for most providers.
 * - thesvg via jsDelivr is the documented fallback for brands Simple Icons
 *   doesn't host (e.g. Salesforce, which Simple Icons removed for
 *   trademark reasons). Same source is already used for the bundled PDFs
 *   of figma/github/gmail/linear/notion/outlook/slack.
 *
 * Adding another CDN should be a deliberate choice — extend this list
 * and update the manifest in tandem.
 */
const ALLOWED_LOGO_URL_PREFIXES = [
  "https://cdn.simpleicons.org/",
  "https://cdn.jsdelivr.net/gh/glincker/thesvg@",
];

describe("PROVIDER_SEED_DATA logo URLs", () => {
  test("every well-known provider has a recognised CDN logoUrl", () => {
    const missing: string[] = [];
    const invalid: Array<{ provider: string; logoUrl: string }> = [];

    for (const [key, seed] of Object.entries(PROVIDER_SEED_DATA)) {
      if (!seed.logoUrl) {
        missing.push(key);
        continue;
      }
      if (
        !ALLOWED_LOGO_URL_PREFIXES.some((prefix) =>
          seed.logoUrl!.startsWith(prefix),
        )
      ) {
        invalid.push({ provider: key, logoUrl: seed.logoUrl });
      }
    }

    expect(missing).toEqual([]);
    expect(invalid).toEqual([]);
  });
});

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";

import { PROVIDER_SEED_DATA } from "../oauth/seed-providers.js";

const REPO_ROOT = dirname(dirname(dirname(import.meta.dir)));
const WEB_PUBLIC_DIR = join(REPO_ROOT, "clients/web/public");
const INTEGRATION_ICON_SOURCE = join(
  REPO_ROOT,
  "clients/web/src/components/integrations/integration-icon.tsx",
);

/**
 * Provider keys the web client draws without a `BUNDLED_LOGO_URLS` entry.
 * Google's mark is multi-colour, so it ships as the `GoogleLogo` component
 * and is returned before the bundled-asset lookup runs.
 */
const COMPONENT_RENDERED_PROVIDERS = new Set(["google"]);

/** `publicAsset("/images/...")` paths from `BUNDLED_LOGO_URLS`, by key. */
function readBundledLogoMap(): Map<string, string> {
  const source = readFileSync(INTEGRATION_ICON_SOURCE, "utf8");
  const block = source.match(
    /const BUNDLED_LOGO_URLS: Record<string, string> = \{([\s\S]*?)\n\};/,
  );
  if (!block) {
    throw new Error(
      `Could not find BUNDLED_LOGO_URLS in ${INTEGRATION_ICON_SOURCE}. If it ` +
        `was renamed or restructured, update this test rather than deleting it.`,
    );
  }
  const entries = new Map<string, string>();
  for (const [, key, path] of block[1]!.matchAll(
    /(\w+):\s*publicAsset\("([^"]+)"\)/g,
  )) {
    entries.set(key!, path!);
  }
  return entries;
}

/**
 * Allowed CDN prefixes for the ``logoUrl`` field on ``PROVIDER_SEED_DATA``
 * (``assistant/src/oauth/seed-providers.ts``):
 *
 * - Simple Icons (CC0) is the default for most providers.
 * - thesvg via jsDelivr is the documented fallback for brands Simple Icons
 *   doesn't host (e.g. Salesforce, which Simple Icons removed for
 *   trademark reasons).
 *
 * Adding another CDN should be a deliberate choice — extend this list.
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

/**
 * The `logoUrl` above is a fallback for providers registered at runtime. Every
 * provider we seed ourselves must draw from an asset we ship, because an icon
 * CDN can drop a brand at any time and the client then degrades to an initials
 * avatar with nothing in CI to notice: the prefix check above passes just as
 * happily for a URL that 404s. Simple Icons hosts no Microsoft mark and no
 * Slack mark, so the seeded URLs for those brands do not resolve there.
 */
describe("PROVIDER_SEED_DATA bundled logo coverage", () => {
  test("every seeded provider renders from a bundled asset", () => {
    const bundled = readBundledLogoMap();
    const uncovered = Object.keys(PROVIDER_SEED_DATA).filter(
      (provider) =>
        !bundled.has(provider) && !COMPONENT_RENDERED_PROVIDERS.has(provider),
    );

    expect(uncovered).toEqual([]);
  });

  test("every bundled logo path resolves to a file on disk", () => {
    const missingFiles = [...readBundledLogoMap()]
      .filter(([, path]) => !existsSync(join(WEB_PUBLIC_DIR, path)))
      .map(([provider, path]) => ({ provider, path }));

    expect(missingFiles).toEqual([]);
  });
});

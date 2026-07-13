/**
 * Fetch the installable plugin catalog from the Vellum platform.
 *
 * The platform serves a flattened view of the curated marketplace at
 * `GET {PLATFORM}/v1/plugins/`. Rows are normalized to {@link MarketplaceEntry}
 * and projected via the shared {@link projectMarketplaceEntries} helper, so a
 * catalog sourced from the platform is indistinguishable from one read off
 * GitHub.
 *
 * Every failure mode (non-2xx, unreachable/aborted, malformed body) throws
 * {@link PluginCatalogUnavailableError} — the fetcher never returns a partial
 * or silently-empty catalog, so a caller can safely fall back to a bundled
 * offline copy instead of mistaking an outage for "no plugins".
 */

import { z } from "zod";

import { getPlatformBaseUrl } from "../../config/env.js";
import type { MarketplaceEntry } from "./plugin-marketplace.js";
import {
  type PluginCatalog,
  PluginCatalogUnavailableError,
  projectMarketplaceEntries,
  type SearchPluginsDeps,
} from "./search-plugins.js";

/**
 * One flattened row from the platform catalog. Unknown keys (`id`,
 * `display_name`, `icon`) are accepted and dropped — zod strips them by
 * default.
 */
const platformPluginRowSchema = z.object({
  name: z.string(),
  repo: z.string().nullable().optional(),
  ref: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  description: z.string().optional(),
  category: z.string().nullable().optional(),
  homepage: z.string().nullable().optional(),
  license: z.string().nullable().optional(),
});

const platformCatalogSchema = z.object({
  plugins: z.array(platformPluginRowSchema),
});

/**
 * Fetch and project the platform catalog. Rows missing `repo`/`ref` are
 * skipped; the rest are deduped by name and sorted alphabetically.
 */
export async function fetchPluginCatalogFromPlatform(
  deps: SearchPluginsDeps,
  opts?: { ref?: string },
): Promise<PluginCatalog> {
  const url = `${getPlatformBaseUrl().replace(/\/+$/, "")}/v1/plugins/`;

  let res: Response;
  try {
    res = await deps.fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "vellum-assistant-cli" },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PluginCatalogUnavailableError(
      `Platform plugin catalog fetch failed: ${detail}`,
      503,
    );
  }

  if (!res.ok) {
    throw new PluginCatalogUnavailableError(
      `Platform plugin catalog fetch failed: HTTP ${res.status}`,
      res.status,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PluginCatalogUnavailableError(
      `Platform plugin catalog returned an invalid body: ${detail}`,
      502,
    );
  }

  const parsed = platformCatalogSchema.safeParse(body);
  if (!parsed.success) {
    throw new PluginCatalogUnavailableError(
      `Platform plugin catalog failed validation: ${parsed.error.message}`,
      502,
    );
  }

  const entries: MarketplaceEntry[] = [];
  for (const row of parsed.data.plugins) {
    if (!row.repo || !row.ref) continue;
    entries.push({
      name: row.name,
      source: {
        source: "github",
        repo: row.repo,
        ref: row.ref,
        path: row.path ?? undefined,
      },
      description: row.description ?? undefined,
      category: row.category ?? undefined,
      homepage: row.homepage ?? undefined,
      license: row.license ?? undefined,
    });
  }

  return { ref: opts?.ref ?? "platform", matches: projectMarketplaceEntries(entries) };
}

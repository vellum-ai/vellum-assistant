/**
 * Fetch the installable plugin catalog from the Vellum platform.
 *
 * The platform serves a flattened view of the curated marketplace at
 * `GET {PLATFORM}/v1/plugins/`. Rows are normalized to {@link MarketplaceEntry}
 * and projected via the shared {@link projectMarketplaceEntries} helper, so a
 * catalog sourced from the platform is indistinguishable from one read off
 * GitHub.
 *
 * Every failure mode (non-2xx, unreachable/aborted, malformed envelope)
 * throws {@link PluginCatalogUnavailableError}, so a caller never mistakes an
 * outage for "no plugins". Rows are validated one at a time: a row with an
 * invalid `integration` is kept without it, and a row that fails the base
 * row schema is skipped, so one bad row never blanks the whole catalog.
 */

import { z } from "zod";

import { getPlatformBaseUrl } from "../../config/env.js";
import { getLogger } from "../../util/logger.js";
import {
  type MarketplaceEntry,
  mcpIntegrationSchema,
} from "./plugin-marketplace.js";
import {
  type PluginCatalog,
  PluginCatalogUnavailableError,
  projectMarketplaceEntries,
  type SearchPluginsDeps,
} from "./search-plugins.js";

const log = getLogger("plugin-catalog");

/**
 * One flattened row from the platform catalog. Unknown keys (`id`,
 * `display_name`) are accepted and dropped (zod strips them by default).
 * `integration` is validated separately by {@link integrationSchema}.
 */
const platformPluginRowSchema = z.object({
  name: z.string(),
  repo: z.string().nullable().optional(),
  ref: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  description: z.string().optional(),
  icon: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  homepage: z.string().nullable().optional(),
  license: z.string().nullable().optional(),
  integration: z.unknown(),
});

const integrationSchema = mcpIntegrationSchema.nullable().optional();

const platformCatalogSchema = z.object({
  plugins: z.array(z.unknown()),
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
  const skippedRows: string[] = [];
  const droppedIntegrations: string[] = [];
  for (const [index, rawRow] of parsed.data.plugins.entries()) {
    const rowResult = platformPluginRowSchema.safeParse(rawRow);
    if (!rowResult.success) {
      skippedRows.push(describeInvalidRow(rawRow, index));
      continue;
    }
    const row = rowResult.data;
    if (!row.repo || !row.ref) {
      continue;
    }
    const integrationResult = integrationSchema.safeParse(row.integration);
    if (!integrationResult.success) {
      droppedIntegrations.push(row.name);
    }
    entries.push({
      name: row.name,
      source: {
        source: "github",
        repo: row.repo,
        ref: row.ref,
        path: row.path ?? undefined,
      },
      description: row.description ?? undefined,
      icon: row.icon ?? undefined,
      category: row.category ?? undefined,
      homepage: row.homepage ?? undefined,
      license: row.license ?? undefined,
      integration: integrationResult.success
        ? (integrationResult.data ?? undefined)
        : undefined,
    });
  }

  if (skippedRows.length > 0 || droppedIntegrations.length > 0) {
    log.warn(
      { skippedRows, droppedIntegrations },
      "platform plugin catalog contained invalid rows; skipped rows and dropped integrations",
    );
  }

  return {
    ref: opts?.ref ?? "platform",
    matches: projectMarketplaceEntries(entries),
  };
}

/** Name of an invalid row for logging, or its position when it has none. */
function describeInvalidRow(row: unknown, index: number): string {
  if (row && typeof row === "object" && "name" in row) {
    const name = (row as { name: unknown }).name;
    if (typeof name === "string" && name.length > 0) {
      return name;
    }
  }
  return `#${index}`;
}

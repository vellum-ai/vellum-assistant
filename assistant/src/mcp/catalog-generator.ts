import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { marketplaceManifestSchema } from "../cli/lib/plugin-marketplace.js";
import { ConfigError } from "../util/errors.js";
import { readStandardCatalogPackage } from "./catalog-manifests.js";
import {
  type BundledMcpCatalog,
  mcpCatalogIndexSchema,
} from "./catalog-schema.js";
import {
  standardDefinitionDigest,
  type StandardDefinitionIssue,
} from "./standard-definitions.js";

export async function buildMcpCatalog(repoRoot: string): Promise<{
  catalog: BundledMcpCatalog;
  issues: Array<StandardDefinitionIssue & { catalogId: string }>;
}> {
  const index = mcpCatalogIndexSchema.parse(
    JSON.parse(
      await readFile(join(repoRoot, "plugins/mcp-catalog.json"), "utf8"),
    ),
  );
  const catalog: BundledMcpCatalog = { version: 1, entries: [] };
  const issues: Array<StandardDefinitionIssue & { catalogId: string }> = [];
  const packages = new Map(
    [...new Set(index.entries.map((entry) => entry.packagePath))].map(
      (path) =>
        [
          path,
          readStandardCatalogPackage(join(repoRoot, path), repoRoot),
        ] as const,
    ),
  );
  const marketplace = index.entries.some(
    (entry) => entry.source.kind === "marketplace",
  )
    ? marketplaceManifestSchema.parse(
        JSON.parse(
          await readFile(join(repoRoot, "plugins/marketplace.json"), "utf8"),
        ),
      ).plugins
    : [];
  for (const entry of [...index.entries].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    const result = await packages.get(entry.packagePath)!;
    issues.push(
      ...result.issues.map((issue) => ({ ...issue, catalogId: entry.id })),
    );
    if (!result.ok || !Object.hasOwn(result.servers, entry.serverKey)) {
      throw new ConfigError(
        `Catalog ${entry.id} has no usable standard server ${entry.serverKey}: ${JSON.stringify(result.issues)}`,
      );
    }
    const definitionDigest = standardDefinitionDigest(result.documents);
    if (
      entry.source.kind !== "local" &&
      entry.source.definitionDigest !== definitionDigest
    ) {
      throw new ConfigError(
        `Catalog ${entry.id} does not match its reviewed source digest`,
      );
    }
    const source = entry.source;
    const resolvedSource =
      source.kind === "github"
        ? source.repository
        : source.kind === "marketplace"
          ? marketplace.find((plugin) => plugin.name === source.name)?.source
          : undefined;
    if (entry.source.kind === "marketplace" && !resolvedSource) {
      throw new ConfigError(
        `Catalog ${entry.id} references an unknown marketplace source`,
      );
    }
    catalog.entries.push({
      ...entry,
      definitionDigest,
      documents: result.documents,
      ...(resolvedSource ? { resolvedSource } : {}),
    });
  }
  return { catalog, issues };
}

export async function generateMcpCatalog(
  repoRoot: string,
  check: boolean,
): Promise<void> {
  const { catalog, issues } = await buildMcpCatalog(repoRoot);
  for (const issue of issues) {
    console.warn(
      `${issue.catalogId}: ${issue.code}${issue.serverKey ? ` (${issue.serverKey})` : ""}: ${issue.message}`,
    );
  }
  const output = `${JSON.stringify(catalog, null, 2)}\n`;
  const path = join(repoRoot, "assistant/src/mcp/bundled-catalog.json");
  if (check) {
    if ((await readFile(path, "utf8")) !== output) {
      throw new ConfigError(
        "Bundled MCP catalog is stale; run bun scripts/plugins/generate-mcp-catalog.ts",
      );
    }
  } else {
    await writeFile(path, output);
  }
}

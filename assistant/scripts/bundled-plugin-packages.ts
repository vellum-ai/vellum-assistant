import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import {
  AGENT_PLUGINS_MCP_SCHEMA_URL,
  SpecMcpDocumentSchema,
  SpecMcpServerSchema,
} from "../src/mcp/spec-schema.js";
import {
  readPluginManifest,
  STANDARD_PLUGIN_MANIFEST,
} from "../src/util/plugin-manifest.js";

export interface BundledPackageFile {
  path: string;
  contentBase64: string;
}

export interface BundledPackage {
  version: string;
  files: BundledPackageFile[];
}

/** Validate and embed every local source in the canonical marketplace. */
export function buildBundledPluginPackages(
  repoRoot: string,
): Record<string, BundledPackage> {
  const marketplacePath = join(repoRoot, "plugins", "marketplace.json");
  const manifest = JSON.parse(readFileSync(marketplacePath, "utf8")) as {
    plugins?: unknown;
  };
  if (!Array.isArray(manifest.plugins)) {
    throw new Error("plugins/marketplace.json is missing its plugins array");
  }

  const pluginsRoot = realpathSync(join(repoRoot, "plugins"));
  const packages: Record<string, BundledPackage> = {};
  for (const rawEntry of manifest.plugins) {
    if (typeof rawEntry !== "object" || rawEntry === null) {
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    const rawSource = entry.source;
    if (typeof rawSource !== "object" || rawSource === null) {
      continue;
    }
    const source = rawSource as Record<string, unknown>;
    if (source.source !== "local") {
      continue;
    }
    if (
      typeof entry.name !== "string" ||
      typeof source.path !== "string" ||
      typeof source.version !== "string"
    ) {
      throw new Error(
        "local marketplace entries require name, path, and version",
      );
    }

    const pathSegments = source.path.split("/");
    if (
      !source.path.startsWith("plugins/") ||
      source.path.includes("\\") ||
      pathSegments.some(
        (segment) => segment === "" || segment === "." || segment === "..",
      )
    ) {
      throw new Error(
        `local marketplace package path is not canonical: ${source.path}`,
      );
    }
    let packageRoot = resolve(repoRoot);
    for (const segment of pathSegments) {
      packageRoot = join(packageRoot, segment);
      if (lstatSync(packageRoot).isSymbolicLink()) {
        throw new Error(
          `local marketplace package path may not contain symlinks: ${source.path}`,
        );
      }
    }
    const packageRealpath = realpathSync(packageRoot);
    const relativeToPlugins = relative(pluginsRoot, packageRealpath);
    if (
      relativeToPlugins === "" ||
      relativeToPlugins === ".." ||
      relativeToPlugins.startsWith(`..${sep}`)
    ) {
      throw new Error(
        `local marketplace package escapes plugins/: ${source.path}`,
      );
    }

    const pluginManifest = readPluginManifest(packageRealpath);
    if (
      pluginManifest.source !== STANDARD_PLUGIN_MANIFEST ||
      pluginManifest.name !== entry.name ||
      pluginManifest.version !== source.version
    ) {
      throw new Error(
        `local marketplace package ${source.path} must match entry name and version`,
      );
    }
    const rawMcp = JSON.parse(
      readFileSync(join(packageRealpath, "mcp.json"), "utf8"),
    ) as unknown;
    const mcp = SpecMcpDocumentSchema.parse(rawMcp);
    if (mcp.$schema !== AGENT_PLUGINS_MCP_SCHEMA_URL) {
      throw new Error(
        `local marketplace package ${source.path} must use the Agent Plugins MCP schema`,
      );
    }
    if (Object.keys(mcp.mcpServers).length === 0) {
      throw new Error(
        `local marketplace package ${source.path} must declare an MCP server`,
      );
    }
    for (const server of Object.values(mcp.mcpServers)) {
      SpecMcpServerSchema.parse(server);
    }

    const files: BundledPackageFile[] = [];
    const visit = (directory: string): void => {
      for (const child of readdirSync(directory, { withFileTypes: true })) {
        const childPath = join(directory, child.name);
        if (child.isSymbolicLink() || lstatSync(childPath).isSymbolicLink()) {
          throw new Error(
            `local marketplace packages may not contain symlinks: ${source.path}/${child.name}`,
          );
        }
        if (child.isDirectory()) {
          visit(childPath);
          continue;
        }
        if (!child.isFile()) {
          throw new Error(
            `local marketplace package contains an unsupported entry: ${childPath}`,
          );
        }
        files.push({
          path: relative(packageRealpath, childPath).split(sep).join("/"),
          contentBase64: readFileSync(childPath).toString("base64"),
        });
      }
    };
    visit(packageRealpath);
    files.sort((a, b) => a.path.localeCompare(b.path));
    if (packages[source.path]) {
      throw new Error(`duplicate local marketplace package: ${source.path}`);
    }
    packages[source.path] = { version: source.version, files };
  }
  return packages;
}

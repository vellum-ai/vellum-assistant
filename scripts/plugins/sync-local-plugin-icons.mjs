#!/usr/bin/env node
/**
 * Derive browser-compatible logo copies from package-owned local plugin icons.
 *
 * Usage:
 *   node scripts/plugins/sync-local-plugin-icons.mjs
 *   node scripts/plugins/sync-local-plugin-icons.mjs --check
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validatePluginIconBytes } from "./generate-plugin-icons.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const LOCAL_MCP_ROOT = "plugins/mcp-catalog";
const DERIVED_SUFFIX = "-mcp.png";

function isFile(path) {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

function readJson(path, label, errors) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    errors.push(`cannot read ${label} at ${path}: ${err.message}`);
    return undefined;
  }
}

function localMcpEntries(marketplace) {
  return (marketplace?.plugins ?? []).filter(
    (entry) =>
      entry?.source?.source === "local" && entry?.integration?.kind === "mcp",
  );
}

function inspectLocalMcpIcons({ repoRoot, marketplacePath }) {
  const errors = [];
  const marketplace = readJson(marketplacePath, "marketplace", errors);
  const icons = [];
  const seenNames = new Set();

  for (const entry of localMcpEntries(marketplace)) {
    const name = entry.name;
    if (typeof name !== "string" || !PLUGIN_NAME_RE.test(name)) {
      errors.push(`invalid local MCP plugin name ${JSON.stringify(name)}`);
      continue;
    }
    if (seenNames.has(name)) {
      errors.push(`duplicate local MCP plugin name "${name}"`);
      continue;
    }
    seenNames.add(name);

    const expectedSourcePath = `${LOCAL_MCP_ROOT}/${name}`;
    if (entry.source.path !== expectedSourcePath) {
      errors.push(
        `local MCP plugin "${name}" must use source.path "${expectedSourcePath}"`,
      );
      continue;
    }

    const expectedLogo = `${name}${DERIVED_SUFFIX}`;
    if (entry.integration.logo !== expectedLogo) {
      errors.push(
        `local MCP plugin "${name}" must use integration.logo "${expectedLogo}"`,
      );
    }

    const packageRoot = join(repoRoot, expectedSourcePath);
    const pluginManifestPath = join(packageRoot, "plugin.json");
    const pluginManifest = readJson(
      pluginManifestPath,
      `plugin manifest for "${name}"`,
      errors,
    );
    if (pluginManifest?.name !== name) {
      errors.push(`plugin manifest for "${name}" must declare name "${name}"`);
    }
    if (
      typeof pluginManifest?.version !== "string" ||
      entry.source.version !== pluginManifest.version
    ) {
      errors.push(
        `local MCP plugin "${name}" source.version must match plugin.json version`,
      );
    }

    const iconPath = join(packageRoot, "icon.png");
    if (!isFile(iconPath)) {
      errors.push(`local MCP plugin "${name}" has no package-owned icon.png`);
      continue;
    }

    const bytes = readFileSync(iconPath);
    if (!validatePluginIconBytes(bytes).hasIcon) {
      errors.push(
        `local MCP plugin "${name}" icon.png is not a contract-valid PNG`,
      );
      continue;
    }

    icons.push({ name, bytes, logo: expectedLogo });
  }

  return { errors, icons };
}

function listDerivedLogos(webAssetsDir) {
  if (!statSync(webAssetsDir, { throwIfNoEntry: false })?.isDirectory()) {
    return [];
  }
  return readdirSync(webAssetsDir)
    .filter((name) => name.endsWith(DERIVED_SUFFIX))
    .sort();
}

/**
 * Validate all local MCP package icons and either derive their static web
 * copies or check that the committed copies are byte-identical.
 */
export function syncLocalPluginIcons({
  repoRoot = REPO_ROOT,
  marketplacePath = join(repoRoot, "plugins/marketplace.json"),
  webAssetsDir = join(repoRoot, "clients/web/public/images/integrations"),
  check = false,
  log = console,
} = {}) {
  const { errors, icons } = inspectLocalMcpIcons({ repoRoot, marketplacePath });
  const expectedLogos = new Set(icons.map(({ logo }) => logo));
  const stale = listDerivedLogos(webAssetsDir).filter(
    (name) => !expectedLogos.has(name),
  );

  if (check && errors.length === 0) {
    for (const { name, bytes, logo } of icons) {
      const webPath = join(webAssetsDir, logo);
      if (!isFile(webPath)) {
        errors.push(`local MCP plugin "${name}" has no derived web logo ${logo}`);
        continue;
      }
      if (!readFileSync(webPath).equals(bytes)) {
        errors.push(`derived web logo ${logo} differs from ${name}/icon.png`);
      }
    }
    for (const logo of stale) {
      errors.push(`stale derived local MCP logo ${logo}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, synced: [], removed: [] };
  }

  if (check) {
    return { ok: true, errors: [], synced: [], removed: [] };
  }

  mkdirSync(webAssetsDir, { recursive: true });
  for (const { bytes, logo } of icons) {
    writeFileSync(join(webAssetsDir, logo), bytes);
  }
  for (const logo of stale) {
    rmSync(join(webAssetsDir, logo));
  }

  const synced = icons.map(({ logo }) => logo).sort();
  log.log?.(`Synced ${synced.length} local MCP plugin icon(s).`);
  return { ok: true, errors: [], synced, removed: stale };
}

function cli(argv) {
  const unknown = argv.filter((arg) => arg !== "--check" && arg !== "--help");
  if (unknown.length > 0) {
    console.error(`Unknown argument: ${unknown[0]}`);
    process.exit(2);
  }
  if (argv.includes("--help")) {
    console.log(
      "Usage: node scripts/plugins/sync-local-plugin-icons.mjs [--check]",
    );
    return;
  }

  const check = argv.includes("--check");
  const result = syncLocalPluginIcons({ check });
  if (!result.ok) {
    console.error("Local MCP plugin icons are invalid or out of sync:");
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    if (check) {
      console.error(
        "\nRun `node scripts/plugins/sync-local-plugin-icons.mjs` and commit the result.",
      );
    }
    process.exit(1);
  }
  if (check) {
    console.log("OK: local MCP package icons match their derived web copies.");
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(realpathSync(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  cli(process.argv.slice(2));
}

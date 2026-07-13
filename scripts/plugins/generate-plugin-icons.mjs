#!/usr/bin/env node
/**
 * Resolve, validate, and vendor marketplace plugin `icon.png` files, then
 * emit the derived `plugins/plugin-icons.json` index.
 *
 * WRITE mode (default): for each entry in `plugins/marketplace.json`, fetch
 * `<source.path>/icon.png` at the pinned `source.ref` via the GitHub Contents
 * API, validate the bytes against the icon contract, and — on success —
 * vendor them to `plugins/assets/<name>/icon.png` and index the plugin in
 * `plugins/plugin-icons.json`. Invalid, missing, or unfetchable icons are
 * fail-closed: skipped, pruned, and omitted from the manifest.
 *
 * CHECK mode (`--check`): purely local. Recompute the content hash of every
 * vendored `icon.png` and assert it matches the committed manifest, with no
 * orphan manifest entries and no unlisted asset dirs. No network.
 *
 * Usage:
 *   node scripts/plugins/generate-plugin-icons.mjs          # write
 *   node scripts/plugins/generate-plugin-icons.mjs --check  # verify
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const MARKETPLACE_PATH = join(REPO_ROOT, "plugins/marketplace.json");
const ASSETS_DIR = join(REPO_ROOT, "plugins/assets");
const MANIFEST_PATH = join(REPO_ROOT, "plugins/plugin-icons.json");
const ICON_FILENAME = "icon.png";

// ---------------------------------------------------------------------------
// Icon validation
//
// Mirrors `validatePluginIconBytes` in
// `assistant/src/cli/lib/plugin-icon-file.ts` — the authoritative
// implementation — kept byte-identical so a plugin that validates for the
// assistant vendors here too. See `docs/plugin-icon-contract.md` for the spec.
// Re-implemented (not imported) because this script runs under plain `node`,
// which cannot import the TypeScript source.
// ---------------------------------------------------------------------------

const MAX_ICON_BYTES = 32 * 1024;
const MAX_ICON_DIMENSION = 128;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR_LENGTH = 13;
const PNG_IHDR_TYPE = Buffer.from("IHDR", "ascii");
const MIN_HEADER_BYTES = 24;

/**
 * Validate in-memory PNG bytes against the icon contract. Returns
 * `{ hasIcon: true, iconVersion }` only for a PNG whose IHDR dimensions and
 * total size are within bounds; every other case returns `{ hasIcon: false }`.
 */
export function validatePluginIconBytes(bytes) {
  if (bytes.length < MIN_HEADER_BYTES || bytes.length > MAX_ICON_BYTES) {
    return { hasIcon: false };
  }
  if (!bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return { hasIcon: false };
  }
  if (
    bytes.readUInt32BE(8) !== PNG_IHDR_LENGTH ||
    !bytes.subarray(12, 16).equals(PNG_IHDR_TYPE)
  ) {
    return { hasIcon: false };
  }

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (
    width <= 0 ||
    height <= 0 ||
    width > MAX_ICON_DIMENSION ||
    height > MAX_ICON_DIMENSION
  ) {
    return { hasIcon: false };
  }

  return { hasIcon: true, iconVersion: iconVersionOf(bytes) };
}

/** First 16 hex chars of sha256(bytes) — the stable content version. */
export function iconVersionOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isFile(path) {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

/** Names of `plugins/assets/*` subdirectories (icon may or may not be present). */
function listAssetDirs(assetsDir) {
  return readdirSync(assetsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** GitHub Contents API URL for a plugin's `icon.png` at its pinned ref. */
function iconContentsUrl(entry) {
  const filePath = entry.source.path
    ? `${entry.source.path}/${ICON_FILENAME}`
    : ICON_FILENAME;
  return (
    `https://api.github.com/repos/${entry.source.repo}` +
    `/contents/${filePath}?ref=${encodeURIComponent(entry.source.ref)}`
  );
}

/**
 * Fetch a plugin's raw `icon.png` bytes at its pinned ref. Returns the Buffer,
 * or `null` for a missing file (404) — both normal, non-fatal outcomes. Any
 * other HTTP failure throws so the caller can log and fail-closed.
 */
async function fetchIconBytes(fetchImpl, entry, token) {
  const headers = {
    Accept: "application/vnd.github.raw",
    "User-Agent": "vellum-assistant-cli",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetchImpl(iconContentsUrl(entry), { headers });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Serialize the manifest deterministically: sorted names, trailing newline. */
function serializeManifest(versionsByName) {
  const plugins = {};
  for (const name of Object.keys(versionsByName).sort()) {
    plugins[name] = { iconVersion: versionsByName[name] };
  }
  return `${JSON.stringify({ version: 1, plugins }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Write mode
// ---------------------------------------------------------------------------

/**
 * Resolve, validate, and vendor every marketplace plugin's `icon.png`, then
 * write the derived manifest. Prunes asset dirs for plugins that no longer
 * ship a valid icon. Returns `{ vendored, skipped }` name lists.
 */
export async function generatePluginIcons({
  fetch: fetchImpl = globalThis.fetch,
  marketplacePath = MARKETPLACE_PATH,
  assetsDir = ASSETS_DIR,
  manifestPath = MANIFEST_PATH,
  token = process.env.GITHUB_TOKEN,
  log = console,
} = {}) {
  const manifest = JSON.parse(readFileSync(marketplacePath, "utf-8"));
  const entries = manifest.plugins ?? [];

  const versionsByName = {};
  const vendored = [];
  const skipped = [];

  for (const entry of entries) {
    let bytes;
    try {
      bytes = await fetchIconBytes(fetchImpl, entry, token);
    } catch (err) {
      log.warn?.(`skip ${entry.name}: icon fetch failed (${err.message})`);
      skipped.push(entry.name);
      continue;
    }

    if (!bytes) {
      skipped.push(entry.name);
      continue;
    }

    const result = validatePluginIconBytes(bytes);
    if (!result.hasIcon) {
      log.warn?.(`skip ${entry.name}: icon.png failed validation`);
      skipped.push(entry.name);
      continue;
    }

    const dir = join(assetsDir, entry.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ICON_FILENAME), bytes);
    versionsByName[entry.name] = result.iconVersion;
    vendored.push(entry.name);
  }

  // Prune asset dirs no longer backed by a valid vendored icon.
  const keep = new Set(vendored);
  if (statSync(assetsDir, { throwIfNoEntry: false })?.isDirectory()) {
    for (const name of listAssetDirs(assetsDir)) {
      if (!keep.has(name)) {
        rmSync(join(assetsDir, name), { recursive: true, force: true });
      }
    }
  }

  writeFileSync(manifestPath, serializeManifest(versionsByName));

  log.log?.(
    `Vendored ${vendored.length} icon(s); ${skipped.length} plugin(s) without a valid icon.`,
  );
  return { vendored: vendored.sort(), skipped: skipped.sort() };
}

// ---------------------------------------------------------------------------
// Check mode
// ---------------------------------------------------------------------------

/**
 * Verify the committed manifest against the vendored assets, purely locally:
 * every asset's content hash matches its manifest entry, with no orphan
 * manifest entries and no unlisted or icon-less asset dirs. Returns
 * `{ ok, errors }`.
 */
export function checkPluginIcons({
  assetsDir = ASSETS_DIR,
  manifestPath = MANIFEST_PATH,
} = {}) {
  const errors = [];

  let manifestPlugins = {};
  try {
    manifestPlugins = JSON.parse(readFileSync(manifestPath, "utf-8")).plugins ?? {};
  } catch (err) {
    return { ok: false, errors: [`cannot read ${manifestPath}: ${err.message}`] };
  }

  const assetNames = statSync(assetsDir, { throwIfNoEntry: false })?.isDirectory()
    ? listAssetDirs(assetsDir)
    : [];

  for (const name of assetNames) {
    const iconPath = join(assetsDir, name, ICON_FILENAME);
    if (!isFile(iconPath)) {
      errors.push(`asset dir "${name}" has no ${ICON_FILENAME}`);
      continue;
    }
    const version = iconVersionOf(readFileSync(iconPath));
    const entry = manifestPlugins[name];
    if (!entry) {
      errors.push(`asset "${name}" is not listed in the manifest`);
    } else if (entry.iconVersion !== version) {
      errors.push(
        `iconVersion mismatch for "${name}": asset=${version} manifest=${entry.iconVersion}`,
      );
    }
  }

  const assetSet = new Set(assetNames);
  for (const name of Object.keys(manifestPlugins)) {
    if (!assetSet.has(name)) {
      errors.push(`manifest entry "${name}" has no vendored asset`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function cli(argv) {
  if (argv.includes("--check")) {
    const { ok, errors } = checkPluginIcons();
    if (!ok) {
      console.error("plugin-icons.json is out of sync with plugins/assets/:");
      for (const e of errors) {
        console.error(`  - ${e}`);
      }
      console.error(
        "\nRun `node scripts/plugins/generate-plugin-icons.mjs` and commit the result.",
      );
      process.exit(1);
    }
    console.log("OK: plugin-icons.json matches the vendored assets.");
    return;
  }

  await generatePluginIcons();
}

const invokedPath = process.argv[1]
  ? pathToFileURL(realpathSync(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  await cli(process.argv.slice(2));
}

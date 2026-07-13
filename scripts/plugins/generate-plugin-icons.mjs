#!/usr/bin/env node
/**
 * Resolve, validate, and vendor marketplace plugin `icon.png` files, then
 * emit the derived `plugins/plugin-icons.json` index.
 *
 * WRITE mode (default): for each entry in `plugins/marketplace.json`, fetch
 * `<source.path>/icon.png` at the pinned `source.ref` via the GitHub Contents
 * API, validate the bytes against the icon contract, and — on success —
 * vendor them to `plugins/assets/<name>/icon.png` and index the plugin in
 * `plugins/plugin-icons.json`. Invalid or missing (404) icons are fail-closed:
 * skipped, pruned, and omitted from the manifest. A non-404 fetch failure
 * (transient 429/5xx/network or a hard error) aborts the whole run before any
 * asset/manifest is written, so an outage never silently drops a pinned icon.
 *
 * CHECK mode (`--check`): purely local. Re-validate every vendored `icon.png`
 * against the icon contract and assert its content hash matches the committed
 * manifest, with no orphan manifest entries and no unlisted asset dirs. No
 * network.
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
function iconVersionOf(bytes) {
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
 * A non-404 icon fetch failure. Mirrors `MarketplaceFetchError` in
 * `plugin-marketplace.ts`: `transient` flags a retryable upstream hiccup
 * (429/5xx/network) vs a hard error. A 404 never reaches here — it is a normal
 * "no icon" result, not a failure.
 */
class IconFetchError extends Error {
  constructor(message, { transient = false } = {}) {
    super(message);
    this.name = "IconFetchError";
    this.transient = transient;
  }
}

/**
 * Classify an upstream GitHub status as transient (worth retrying) vs hard.
 * Mirrors `isTransientUpstreamStatus` in `plugin-marketplace.ts`: 429 or 5xx
 * is always transient; a 403 is a rate-limit signal only when the remaining
 * quota header is exhausted, otherwise it is a hard authorization failure.
 */
export function isTransientUpstreamStatus(res) {
  if (res.status === 429 || res.status >= 500) return true;
  if (res.status === 403) {
    return res.headers?.get?.("x-ratelimit-remaining") === "0";
  }
  return false;
}

/**
 * Fetch a plugin's raw `icon.png` bytes at its pinned ref. Returns the Buffer,
 * or `null` for a missing file (404) — the only "no icon" outcome. Every other
 * failure throws {@link IconFetchError}: a network/DNS error or a 429/5xx is
 * `transient`, so the caller aborts rather than silently dropping a still-valid
 * vendored icon.
 */
async function fetchIconBytes(fetchImpl, entry, token) {
  const headers = {
    Accept: "application/vnd.github.raw",
    "User-Agent": "vellum-assistant-cli",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetchImpl(iconContentsUrl(entry), { headers });
  } catch (err) {
    // Network/DNS/connection throw — retryable upstream hiccup.
    throw new IconFetchError(`network error: ${err.message}`, {
      transient: true,
    });
  }
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new IconFetchError(`HTTP ${res.status}`, {
      transient: isTransientUpstreamStatus(res),
    });
  }
  // Reject an oversized icon on its advertised Content-Length before buffering
  // it — a huge upstream icon.png would otherwise be materialized whole only to
  // be rejected by the byte cap. A hard (non-transient) failure: the validator
  // still catches a missing/lying length once the bytes are in memory.
  const contentLength = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_ICON_BYTES) {
    throw new IconFetchError(
      `icon.png is ${contentLength} bytes, over the ${MAX_ICON_BYTES}-byte cap`,
      { transient: false },
    );
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
  const toVendor = [];
  const vendored = [];
  const skipped = [];

  // Resolve every icon fully in memory before touching disk. A non-404 fetch
  // failure (transient 429/5xx/network or a hard error) aborts here — we cannot
  // confirm the icon is gone, so treating it as "no icon" would prune a
  // still-valid vendored icon during an outage. Deferring all writes past this
  // loop guarantees an abort leaves the working tree unchanged.
  for (const entry of entries) {
    let bytes;
    try {
      bytes = await fetchIconBytes(fetchImpl, entry, token);
    } catch (err) {
      const kind = err.transient ? "transient " : "";
      throw new Error(
        `Aborting icon generation: ${kind}icon fetch failed for ${entry.name} (${err.message}). ` +
          `No assets or manifest were modified; re-run once upstream recovers.`,
      );
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

    toVendor.push({ name: entry.name, bytes });
    versionsByName[entry.name] = result.iconVersion;
    vendored.push(entry.name);
  }

  // Every icon resolved cleanly — safe to mutate the working tree now.
  for (const { name, bytes } of toVendor) {
    const dir = join(assetsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ICON_FILENAME), bytes);
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
    // Re-run the icon contract (PNG magic + IHDR dims + byte cap), not just the
    // hash: a hand-committed malformed/oversized blob whose manifest hash was
    // updated to match must still fail this network-free guard.
    const result = validatePluginIconBytes(readFileSync(iconPath));
    if (!result.hasIcon) {
      errors.push(
        `asset "${name}" is not a contract-valid PNG (magic/dimensions/size)`,
      );
      continue;
    }
    const version = result.iconVersion;
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

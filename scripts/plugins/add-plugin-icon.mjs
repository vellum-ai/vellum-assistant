#!/usr/bin/env node
/**
 * One-command authoring flow for a marketplace plugin's icon.
 *
 * Collapses the three-step ritual (curate emoji → vendor PNG → sync bundled
 * copy) into a single invocation:
 *
 *   1. (optional, with `--emoji`) set the curated `icon` emoji on the plugin's
 *      entry in `plugins/marketplace.json`, patching just that one field and
 *      preserving the file's exact serialization so unrelated entries don't churn.
 *   2. run the icon generator to fetch/validate/vendor every plugin's `icon.png`
 *      and regenerate `plugins/plugin-icons.json` (see generate-plugin-icons.mjs).
 *   3. run `meta/sync-bundled-copies.ts` so the bundled offline marketplace copy
 *      at `assistant/src/cli/lib/bundled-marketplace.json` stays in lockstep.
 *
 * All emoji preconditions (plugin exists, emoji shape, file is in canonical form)
 * are validated up front, before any write or network call — so a transient
 * generator failure leaves `marketplace.json` untouched, and the whole flow is
 * safe to re-run idempotently.
 *
 * Usage:
 *   node scripts/plugins/add-plugin-icon.mjs <plugin-name>
 *   node scripts/plugins/add-plugin-icon.mjs <plugin-name> --emoji ☕
 *
 * A `GITHUB_TOKEN` in the environment lifts the generator's unauthenticated
 * GitHub rate limit — recommended, since the generator re-fetches every plugin's
 * icon.png on each run.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generatePluginIcons } from "./generate-plugin-icons.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const MARKETPLACE_PATH = join(REPO_ROOT, "plugins/marketplace.json");
const SYNC_SCRIPT = "meta/sync-bundled-copies.ts";

/**
 * Serialize marketplace data to the exact on-disk canonical form: 2-space
 * indent, non-ASCII escaped as `\uXXXX` (matching the committed file, which
 * escapes emoji and punctuation like `—`), trailing newline. `JSON.stringify`
 * emits raw Unicode, so the escape pass is what keeps a one-field edit from
 * flipping every existing escaped character in the file.
 */
export function serializeMarketplace(data) {
  const json = JSON.stringify(data, null, 2).replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  return `${json}\n`;
}

/**
 * Whether `value` is a valid curated `icon` per the marketplace schema — so this
 * tool never writes a value the reader would later reject. Mirrors the `icon`
 * refinement in `marketplaceEntrySchema` (`assistant/src/cli/lib/plugin-marketplace.ts`):
 * at most 8 code points, and no slash/backslash or `http(s):` URL (case-insensitive).
 * We additionally require it be non-empty, since the schema's `.optional()` covers
 * "no icon" but an explicit empty `--emoji ""` is a user error here.
 */
export function isCuratedEmoji(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    [...value].length <= 8 &&
    !/[/\\]|^https?:/i.test(value)
  );
}

/** Run the bundled-copies sync via Bun. Throws with a recovery hint on failure. */
function runSyncScript({ repoRoot = REPO_ROOT, log = console } = {}) {
  log.log?.(`Syncing bundled copies (${SYNC_SCRIPT})…`);
  try {
    execFileSync("bun", ["run", SYNC_SCRIPT], { cwd: repoRoot, stdio: "inherit" });
  } catch (err) {
    throw new Error(
      `Failed to run ${SYNC_SCRIPT} (${err.message}). Ensure Bun is installed ` +
        `and on PATH, then re-run \`bun run ${SYNC_SCRIPT}\` manually.`,
    );
  }
}

/**
 * Vendor a plugin's icon and (optionally) set its curated emoji, then sync the
 * bundled marketplace copy. Injectable `runGenerate`/`runSync` keep it unit
 * testable without network or a Bun subprocess.
 *
 * Returns `{ emojiChanged, previousEmoji, vendored, skipped }` where `vendored`
 * / `skipped` reflect whether THIS plugin ended up with a valid vendored PNG.
 */
export async function addPluginIcon({
  name,
  emoji,
  marketplacePath = MARKETPLACE_PATH,
  runGenerate = (log) => generatePluginIcons({ log }),
  runSync = (log) => runSyncScript({ repoRoot: REPO_ROOT, log }),
  log = console,
} = {}) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("A plugin name is required.");
  }

  // --- Validate everything up front, before any write or network call. ---
  const raw = readFileSync(marketplacePath, "utf-8");
  const data = JSON.parse(raw);
  const entry = (data.plugins ?? []).find((p) => p?.name === name);
  if (!entry) {
    throw new Error(
      `Plugin "${name}" is not in ${marketplacePath}. Add its marketplace ` +
        `entry first — an icon can only attach to a catalogued plugin.`,
    );
  }

  let emojiChanged = false;
  let previousEmoji;
  let willWriteEmoji = false;
  if (emoji !== undefined) {
    if (!isCuratedEmoji(emoji)) {
      throw new Error(
        `--emoji must be a short emoji (at most 8 code points, no slashes or ` +
          `URLs), per the marketplace schema (got ${JSON.stringify(emoji)}).`,
      );
    }
    if (entry.icon === emoji) {
      log.log?.(`Emoji already set to ${emoji} for "${name}" — leaving as is.`);
    } else {
      // Refuse to rewrite unless our serializer reproduces the file byte-for-byte;
      // otherwise a one-field edit would silently reformat unrelated entries.
      if (serializeMarketplace(data) !== raw) {
        throw new Error(
          `${marketplacePath} is not in the canonical 2-space, ASCII-escaped JSON ` +
            `form this tool writes. Refusing to rewrite it to avoid a large unrelated ` +
            `diff — normalize the file first.`,
        );
      }
      willWriteEmoji = true;
      previousEmoji = entry.icon;
    }
  }

  // --- Vendor the PNG + regenerate the manifest first: this is the only step
  //     that hits the network and can abort transiently. Doing it before the
  //     marketplace write means an abort leaves marketplace.json pristine. ---
  const { vendored, skipped } = await runGenerate(log);

  // --- Now the guaranteed-to-succeed local writes. ---
  if (willWriteEmoji) {
    entry.icon = emoji;
    writeFileSync(marketplacePath, serializeMarketplace(data));
    emojiChanged = true;
    log.log?.(
      `Set emoji for "${name}": ${previousEmoji ? `${previousEmoji} → ` : ""}${emoji}`,
    );
  }

  await runSync(log);

  const didVendor = vendored.includes(name);
  if (didVendor) {
    log.log?.(`Vendored a PNG icon for "${name}".`);
  } else {
    log.log?.(
      `No valid upstream icon.png for "${name}" — it will fall back to ` +
        `${entry.icon ? `the emoji ${entry.icon}` : "the generic glyph"}.`,
    );
  }

  return {
    emojiChanged,
    previousEmoji,
    vendored: didVendor,
    skipped: skipped.includes(name),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/plugins/add-plugin-icon.mjs <plugin-name> [--emoji <emoji>]

Vendors <plugin-name>'s icon.png, regenerates plugins/plugin-icons.json, and
syncs the bundled marketplace copy. With --emoji, first sets the curated emoji
fallback on the plugin's marketplace.json entry (a surgical, churn-free patch).

Set GITHUB_TOKEN to lift the generator's unauthenticated GitHub rate limit.`;

export function parseArgs(argv) {
  let name;
  let emoji;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      return { help: true };
    }
    if (arg === "--emoji") {
      emoji = argv[++i];
      if (emoji === undefined) {
        throw new Error("--emoji requires a value.");
      }
      continue;
    }
    if (arg.startsWith("--emoji=")) {
      emoji = arg.slice("--emoji=".length);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    if (name === undefined) {
      name = arg;
      continue;
    }
    throw new Error(`Unexpected extra argument: ${arg}`);
  }
  return { name, emoji };
}

async function cli(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error(`\n${USAGE}`);
    process.exit(2);
  }

  if (parsed.help || !parsed.name) {
    console.log(USAGE);
    process.exit(parsed.help ? 0 : 2);
  }

  try {
    await addPluginIcon({ name: parsed.name, emoji: parsed.emoji });
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(realpathSync(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  await cli(process.argv.slice(2));
}

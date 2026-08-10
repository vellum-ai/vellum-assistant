/**
 * Audits `.touch-signal-allowlist.json`, the ratchet behind
 * `local/no-compound-touch-signal`.
 *
 * The allow-list exists to freeze the population of call sites reading the
 * narrow-AND-coarse compound while overlay presentation moves into the design
 * library (LUM-3177). It is only a ratchet if it shrinks, and it only shrinks
 * if stale entries are noticed. An entry goes stale when its file stops
 * importing the compound (migrated) or stops existing (deleted or renamed),
 * and a stale entry silently re-permits the compound if that file ever reaches
 * for it again.
 *
 *   bun run audit:touch-signal          # report
 *   bun run audit:touch-signal --check  # exit 1 if stale (CI)
 *
 * See `clients/web/docs/PLATFORM_ADAPTATION.md`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST_PATH = path.join(WEB_ROOT, ".touch-signal-allowlist.json");

/** Matches an import whose module basename is `use-touch-mobile`. */
const COMPOUND_IMPORT =
  /^\s*import\s[\s\S]*?from\s+["'][^"']*use-touch-mobile(?:\.[jt]sx?)?["']/m;

const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
const check = process.argv.includes("--check");

const missing = [];
const migrated = [];

for (const key of Object.keys(allowlist)) {
  const abs = path.join(WEB_ROOT, key);
  if (!existsSync(abs)) {
    missing.push(key);
    continue;
  }
  if (!COMPOUND_IMPORT.test(readFileSync(abs, "utf8"))) {
    migrated.push(key);
  }
}

const stale = [...missing, ...migrated];
const remaining = Object.keys(allowlist).length - stale.length;

if (stale.length === 0) {
  console.log(
    `touch-signal allow-list: ${remaining} entries, none stale. ` +
      `Each is a call site still reading the compound.`,
  );
  process.exit(0);
}

for (const key of migrated) {
  console.log(`migrated  ${key}`);
}
for (const key of missing) {
  console.log(`gone      ${key}`);
}
console.log(
  `\n${stale.length} stale, ${remaining} genuinely remaining.`,
);

if (check) {
  console.log("Remove the stale entries (run without --check to do it).");
  process.exit(1);
}

for (const key of stale) {
  delete allowlist[key];
}
writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(allowlist, null, 2)}\n`);
console.log("Pruned. Commit the updated allow-list.");

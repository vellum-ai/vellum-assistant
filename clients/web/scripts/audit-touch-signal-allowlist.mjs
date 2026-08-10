/**
 * Audits `.touch-signal-allowlist.json`, the ratchet behind
 * `local/no-compound-touch-signal`.
 *
 * The allow-list exists to freeze the population of call sites reading the
 * narrow-AND-coarse compound while overlay presentation moves into the design
 * library (LUM-3177). It is only a ratchet if it shrinks, and it only shrinks
 * if stale entries are noticed. An entry goes stale when its file migrates off
 * the compound, loses some of its uses, or stops existing. A stale entry
 * silently re-permits the compound if that file ever reaches for it again.
 *
 *   bun run audit:touch-signal          # report and rewrite
 *   bun run audit:touch-signal:check    # exit 1 if stale (CI)
 *
 * The counts come from running the rule itself with `ignoreAllowlist`, so
 * there is exactly one definition of "uses the compound". A second,
 * hand-rolled definition here would be free to disagree with the rule, and the
 * disagreement would show up as either a pruned entry that lint still needs or
 * a permitted usage lint never sees.
 *
 * See `clients/web/docs/PLATFORM_ADAPTATION.md`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

const WEB_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ALLOWLIST_PATH = path.join(WEB_ROOT, ".touch-signal-allowlist.json");
const RULE = "local/no-compound-touch-signal";

const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
const check = process.argv.includes("--check");

/**
 * Actual usages per file, keyed like the allow-list. Re-runs the rule over
 * `src/` with the allow-list bypassed, so every reference is reported and the
 * message count is the usage count.
 */
async function currentPopulation() {
  const eslint = new ESLint({
    cwd: WEB_ROOT,
    overrideConfig: { rules: { [RULE]: ["error", { ignoreAllowlist: true }] } },
  });
  const results = await eslint.lintFiles(["src"]);
  const counts = new Map();
  for (const result of results) {
    const hits = result.messages.filter((m) => m.ruleId === RULE).length;
    if (hits > 0) {
      const key = path
        .relative(WEB_ROOT, result.filePath)
        .split(path.sep)
        .join("/");
      counts.set(key, hits);
    }
  }
  return counts;
}

const actual = await currentPopulation();

const gone = [];
const shrunk = [];
const grew = [];
const missing = [];

for (const [key, entry] of Object.entries(allowlist)) {
  const uses = actual.get(key);
  if (uses === undefined) {
    gone.push(key);
  } else if (uses < entry.uses) {
    shrunk.push([key, entry.uses, uses]);
  } else if (uses > entry.uses) {
    grew.push([key, entry.uses, uses]);
  }
}
for (const [key, uses] of actual) {
  if (!Object.hasOwn(allowlist, key)) {
    missing.push([key, uses]);
  }
}

const staleCount = gone.length + shrunk.length;
const remaining = Object.keys(allowlist).length - gone.length;
const totalUses = [...actual.values()].reduce((a, b) => a + b, 0);

if (staleCount === 0 && missing.length === 0 && grew.length === 0) {
  console.log(
    `touch-signal allow-list: ${remaining} files, ${totalUses} uses, none stale.`,
  );
  process.exit(0);
}

for (const key of gone) {
  console.log(`migrated  ${key}`);
}
for (const [key, was, now] of shrunk) {
  console.log(`shrunk    ${key} (${was} -> ${now})`);
}
for (const [key, was, now] of grew) {
  // Lint already fails on these; reported so the summary is not misleading.
  console.log(`grew      ${key} (${was} -> ${now}) - lint reports the excess`);
}
for (const [key, uses] of missing) {
  // Lint fails on these anyway; surfaced here so the message is actionable.
  console.log(`unlisted  ${key} (${uses} use(s)) - fix the call site`);
}

if (missing.length > 0) {
  console.log(
    "\nNew call sites are never auto-added. Pick the axis the surface needs.",
  );
  process.exit(1);
}

// Growth is lint's failure to report, not this script's. Raising the budget
// to match would be the ratchet running backwards, so never rewrite for it.
if (staleCount === 0) {
  process.exit(0);
}

console.log(`\n${staleCount} stale entr(ies), ${remaining} genuinely remaining.`);

if (check) {
  console.log("Run 'bun run audit:touch-signal' to prune.");
  process.exit(1);
}

for (const key of gone) {
  delete allowlist[key];
}
for (const [key, , now] of shrunk) {
  allowlist[key].uses = now;
}
writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(allowlist, null, 2)}\n`);
console.log("Pruned. Commit the updated allow-list.");

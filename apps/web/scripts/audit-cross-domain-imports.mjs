#!/usr/bin/env node
/**
 * Audit cross-domain imports under `apps/web/src/domains/` and
 * regenerate `.cross-domain-allowlist.json`.
 *
 * A "cross-domain import" is an import that resolves to a feature
 * folder other than the importer's own — written as
 * `@/domains/<y>/...`, the barrel form `@/domains/<y>`, or a
 * relative path like `../../<y>/foo`. These create hidden
 * couplings between features that are supposed to be independent.
 * The fix is to lift the shared code up to a top-level shared
 * directory, or compose at the page level. See
 * `apps/web/docs/CONVENTIONS.md` → "How to decide where the
 * domain split is" for the reasoning.
 *
 * This script is the source-of-truth generator for the lint
 * allow-list. The ESLint rule
 * `eslint-rules/no-cross-domain-imports.mjs` reads the JSON file
 * this script writes. Don't hand-edit the JSON; regenerate it
 * here after you remove a violation.
 *
 * The matching logic lives in
 * `eslint-rules/cross-domain-matchers.mjs` and is shared with the
 * lint rule so the two never drift apart.
 *
 * Usage:
 *   bun run audit:cross-domain          # write
 *   bun run audit:cross-domain:check    # CI gate (exit 1 if stale)
 *   node apps/web/scripts/audit-cross-domain-imports.mjs --stats
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  DOMAINS_DIR,
  IMPORT_SOURCE_RE,
  WEB_ROOT,
  ownDomainFor,
  targetDomainFor,
} from "../eslint-rules/cross-domain-matchers.mjs";

const ALLOWLIST_PATH = path.join(WEB_ROOT, ".cross-domain-allowlist.json");

/** Recursively yield .ts/.tsx files under a dir. */
async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      yield full;
    }
  }
}

/** Find cross-domain imports for one file. */
async function violationsForFile(filePath) {
  const src = await fs.readFile(filePath, "utf8");
  const owner = ownDomainFor(filePath);
  if (!owner) return [];
  const found = new Set();
  for (const match of src.matchAll(IMPORT_SOURCE_RE)) {
    const target = targetDomainFor(match[1], filePath);
    if (target && target !== owner) found.add(target);
  }
  return [...found].sort();
}

async function audit() {
  const violations = {};
  for await (const filePath of walk(DOMAINS_DIR)) {
    const targets = await violationsForFile(filePath);
    if (targets.length > 0) {
      const rel = path.relative(WEB_ROOT, filePath).split(path.sep).join("/");
      violations[rel] = targets;
    }
  }
  // Sort keys for deterministic output (stable diffs).
  return Object.fromEntries(
    Object.entries(violations).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function totalCount(violations) {
  return Object.values(violations).reduce((sum, t) => sum + t.length, 0);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const violations = await audit();
  const json = JSON.stringify(violations, null, 2) + "\n";

  if (args.has("--stats")) {
    console.log(
      `${Object.keys(violations).length} files with ${totalCount(violations)} cross-domain imports`,
    );
    return;
  }

  if (args.has("--check")) {
    const onDisk = await fs.readFile(ALLOWLIST_PATH, "utf8");
    if (onDisk !== json) {
      console.error(
        "cross-domain allow-list is out of date.\n" +
          "Run: bun run audit:cross-domain",
      );
      process.exit(1);
    }
    return;
  }

  await fs.writeFile(ALLOWLIST_PATH, json);
  console.log(
    `wrote ${path.relative(WEB_ROOT, ALLOWLIST_PATH)} — ` +
      `${Object.keys(violations).length} files, ${totalCount(violations)} imports`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

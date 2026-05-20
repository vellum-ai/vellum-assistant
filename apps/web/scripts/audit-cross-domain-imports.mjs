#!/usr/bin/env node
/**
 * Audit cross-domain imports under `apps/web/src/domains/` and
 * regenerate `.cross-domain-allowlist.json`.
 *
 * A "cross-domain import" is an import of the form
 * `@/domains/<y>/...` inside a file under `src/domains/<x>/...`
 * where `x !== y`. These are smells per
 * `apps/web/CONVENTIONS.md` (and bulletproof-react /
 * Feature-Sliced Design): code consumed by two or more domains
 * should be lifted to a top-level shared dir, not imported
 * peer-to-peer.
 *
 * This script is the source-of-truth generator for the lint
 * allow-list. The custom ESLint rule
 * `eslint-rules/no-cross-domain-imports.mjs` reads the JSON file
 * this script writes. Don't hand-edit the JSON; regenerate it
 * here after you remove a violation.
 *
 * Usage:
 *   node apps/web/scripts/audit-cross-domain-imports.mjs        # write
 *   node apps/web/scripts/audit-cross-domain-imports.mjs --check # CI gate
 *   node apps/web/scripts/audit-cross-domain-imports.mjs --stats # print counts
 *
 * Exit codes (with --check): 0 if the on-disk allow-list matches
 * what the audit would generate, 1 otherwise. Use this in CI to
 * detect when a PR removed a violation but forgot to regenerate
 * the file.
 *
 * See:
 *   apps/web/CONVENTIONS.md → "Top-level shared directories"
 *   LUM-1753 (parent initiative)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..");
const DOMAINS_DIR = path.join(WEB_ROOT, "src/domains");
const ALLOWLIST_PATH = path.join(WEB_ROOT, ".cross-domain-allowlist.json");

const IMPORT_RE = /from\s+["']@\/domains\/([^/"']+)\/[^"']*["']/g;

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

/** Extract the domain segment from a file path under src/domains/. */
function ownDomain(filePath) {
  const rel = path.relative(DOMAINS_DIR, filePath);
  const [first] = rel.split(path.sep);
  return first;
}

/** Find cross-domain imports for one file. */
async function violationsForFile(filePath) {
  const src = await fs.readFile(filePath, "utf8");
  const owner = ownDomain(filePath);
  const found = new Set();
  for (const match of src.matchAll(IMPORT_RE)) {
    const target = match[1];
    if (target !== owner) found.add(target);
  }
  return [...found].sort();
}

async function audit() {
  /** @type {Record<string, string[]>} */
  const violations = {};
  for await (const filePath of walk(DOMAINS_DIR)) {
    const targets = await violationsForFile(filePath);
    if (targets.length > 0) {
      const rel = path.relative(WEB_ROOT, filePath).replaceAll(path.sep, "/");
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
          "Run: node apps/web/scripts/audit-cross-domain-imports.mjs",
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

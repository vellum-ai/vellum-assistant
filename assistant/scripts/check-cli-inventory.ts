#!/usr/bin/env bun
/**
 * Section J — CLI inventory CI check.
 *
 * Walks `assistant/src/cli/commands/**\/*.ts` and extracts every
 * `registerCommand(<parent>, { name, transport })` call. Walks
 * `assistant/src/cli/COMMAND_INVENTORY.md` and extracts every row from
 * the inventory table. Verifies set equality keyed on `Source` (file path
 * relative to repo root), and that each row's `name` + `class` match the
 * underlying `registerCommand` call.
 *
 * The Subcommands / Operation IDs / Status columns are informational and
 * are not validated by this script — they are kept honest by review.
 *
 * Exit codes:
 *   0 — all good
 *   1 — drift detected (missing/extra rows, wrong class, wrong name)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import ts from "typescript";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const COMMANDS_DIR = "assistant/src/cli/commands";
const INVENTORY_PATH = "assistant/src/cli/COMMAND_INVENTORY.md";

type Transport = "ipc" | "local" | "bootstrap";

interface SourceEntry {
  /** Path relative to repo root, e.g. `assistant/src/cli/commands/email.ts`. */
  source: string;
  /** Literal `name` field passed to `registerCommand`. */
  name: string;
  /** Literal `transport` field passed to `registerCommand`. */
  transport: Transport;
}

interface InventoryRow {
  /** Path relative to repo root, parsed from the `Source` column. */
  source: string;
  /** Display name from the `Command` column (may include positional args). */
  command: string;
  /** Transport class from the `Class` column. */
  klass: Transport;
  /** 1-indexed row number in the table for error messages. */
  lineNumber: number;
}

function isTransport(s: string): s is Transport {
  return s === "ipc" || s === "local" || s === "bootstrap";
}

function walkCommandFiles(absDir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(absDir)) {
    const p = join(absDir, ent);
    const s = statSync(p);
    if (s.isDirectory()) {
      // Skip test fixtures.
      if (ent === "__tests__") continue;
      out.push(...walkCommandFiles(p));
    } else if (
      s.isFile() &&
      ent.endsWith(".ts") &&
      !ent.endsWith(".test.ts") &&
      !ent.endsWith(".d.ts")
    ) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Extract zero-or-more `registerCommand(<parent>, { name, transport })` calls
 * from a single source file. Files like `oauth/index.ts` register one
 * command; subcommand files like `oauth/connect.ts` typically don't call
 * `registerCommand` directly (they export a `registerXyz` helper that is
 * invoked from inside the parent's `build` callback).
 *
 * We walk the TS AST rather than regex-matching because comments and
 * template literals routinely contain `(`, `)`, and `'` characters that
 * fool a naive parser.
 *
 * Returns an array; callers should fail if .length > 1 since the
 * inventory format assumes one row per source file.
 */
function parseSourceEntries(absFile: string): SourceEntry[] {
  const src = readFileSync(absFile, "utf8");
  if (!src.includes("registerCommand(")) return [];

  const sf = ts.createSourceFile(
    absFile,
    src,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
    ts.ScriptKind.TS,
  );

  const out: SourceEntry[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "registerCommand" &&
      node.arguments.length >= 2
    ) {
      const optionsArg = node.arguments[1];
      if (ts.isObjectLiteralExpression(optionsArg)) {
        let name: string | null = null;
        let transport: string | null = null;
        for (const prop of optionsArg.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          if (!ts.isIdentifier(prop.name)) continue;
          if (prop.name.text === "name") {
            if (ts.isStringLiteralLike(prop.initializer)) {
              name = prop.initializer.text;
            }
          } else if (prop.name.text === "transport") {
            if (ts.isStringLiteralLike(prop.initializer)) {
              transport = prop.initializer.text;
            }
          }
        }
        if (name && transport && isTransport(transport)) {
          out.push({
            source: relative(REPO_ROOT, absFile),
            name,
            transport,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

function parseInventory(absPath: string): InventoryRow[] {
  const text = readFileSync(absPath, "utf8");
  const lines = text.split("\n");
  const rows: InventoryRow[] = [];

  // Find lines that look like data rows AFTER the "## Inventory" heading.
  // A data row starts with `|`, has at least 6 cells, and is not the
  // header / divider.
  let inInventory = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+Inventory\b/.test(line)) {
      inInventory = true;
      continue;
    }
    if (!inInventory) continue;
    if (!line.startsWith("|")) continue;

    // Skip header + divider rows. The header literal starts with `| Command`.
    if (/^\|\s*Command\s*\|/.test(line)) continue;
    if (/^\|\s*-+\s*\|/.test(line)) continue;

    const cells = line
      .split("|")
      .slice(1, -1) // strip leading/trailing empties from outer pipes
      .map((c) => c.trim());
    if (cells.length < 6) continue;

    const command = stripBackticks(cells[0]);
    const klass = stripBackticks(cells[1]);
    const source = stripBackticks(cells[5]);

    if (!isTransport(klass)) {
      throw new Error(
        `${INVENTORY_PATH}:${i + 1}: invalid Class \`${klass}\`. Expected one of: ipc, local, bootstrap.`,
      );
    }

    rows.push({
      source,
      command,
      klass,
      lineNumber: i + 1,
    });
  }
  return rows;
}

function stripBackticks(s: string): string {
  // Cell may contain backticked tokens; we want the bare text of the first
  // backticked token. For the Source column there's only one. For Command
  // there may be additional context (e.g. "`v2` (under `memory`)") and we
  // want just the leading `name`.
  const m = s.match(/`([^`]+)`/);
  return m ? m[1] : s;
}

function main(): number {
  const cmdAbsDir = resolve(REPO_ROOT, COMMANDS_DIR);
  const invAbs = resolve(REPO_ROOT, INVENTORY_PATH);

  const files = walkCommandFiles(cmdAbsDir).sort();
  const sourceEntries: SourceEntry[] = [];
  for (const f of files) {
    const entries = parseSourceEntries(f);
    if (entries.length > 1) {
      // Multiple registerCommand calls in one file breaks the inventory's
      // one-row-per-file model. Flag it loudly.
      console.error(
        `check-cli-inventory: ${relative(REPO_ROOT, f)} contains ${entries.length} registerCommand calls; ` +
          `expected at most one per file.`,
      );
      process.exit(1);
    }
    if (entries.length === 1) sourceEntries.push(entries[0]);
  }

  const inventoryRows = parseInventory(invAbs);

  const errors: string[] = [];

  const sourceBySrcPath = new Map<string, SourceEntry>(
    sourceEntries.map((e) => [e.source, e]),
  );
  const rowBySrcPath = new Map<string, InventoryRow>(
    inventoryRows.map((r) => [r.source, r]),
  );

  // Detect duplicate inventory rows pointing at the same source file.
  if (inventoryRows.length !== rowBySrcPath.size) {
    const seen = new Set<string>();
    for (const r of inventoryRows) {
      if (seen.has(r.source)) {
        errors.push(
          `${INVENTORY_PATH}:${r.lineNumber}: duplicate Source \`${r.source}\``,
        );
      }
      seen.add(r.source);
    }
  }

  // Source has registerCommand but inventory row is missing.
  for (const e of sourceEntries) {
    const row = rowBySrcPath.get(e.source);
    if (!row) {
      errors.push(
        `Missing inventory row for \`${e.source}\` (registers \`${e.name}\`, transport \`${e.transport}\`). ` +
          `Add a row to ${INVENTORY_PATH}.`,
      );
      continue;
    }
    if (row.klass !== e.transport) {
      errors.push(
        `${INVENTORY_PATH}:${row.lineNumber}: Class \`${row.klass}\` for \`${e.source}\` ` +
          `does not match registerCommand transport \`${e.transport}\`.`,
      );
    }
    // The Command cell may be a namespace path (`oauth apps`) or include a
    // positional argument (`bash <command>`, `defer [conversationId]`). The
    // registered `name` literal must be a suffix of the Command cell — i.e.
    // the cell ends with exactly the registered name (after optional
    // leading namespace tokens).
    if (
      row.command !== e.name &&
      !row.command.endsWith(" " + e.name)
    ) {
      errors.push(
        `${INVENTORY_PATH}:${row.lineNumber}: Command \`${row.command}\` for \`${e.source}\` ` +
          `does not end with registered name \`${e.name}\`.`,
      );
    }
  }

  // Inventory row exists but no registerCommand in source.
  for (const r of inventoryRows) {
    if (!sourceBySrcPath.has(r.source)) {
      errors.push(
        `${INVENTORY_PATH}:${r.lineNumber}: extra inventory row for \`${r.source}\` ` +
          `(no registerCommand call found at that path).`,
      );
    }
  }

  if (errors.length === 0) {
    console.log(
      `check-cli-inventory: ok — ${sourceEntries.length} commands, ${inventoryRows.length} inventory rows.`,
    );
    return 0;
  }

  console.error("check-cli-inventory: drift detected");
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    `\nFix by editing ${INVENTORY_PATH} (see its header for the format).`,
  );
  return 1;
}

process.exit(main());

#!/usr/bin/env bun
/**
 * Bidirectional check: every .ts file under src/cli/commands/ (excl. __tests__/)
 * must appear in COMMAND_INVENTORY.md and vice versa.
 *
 * Usage:
 *   bun run lint:inventory       # exits 1 when mismatch exists
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, relative, join } from "node:path";

const assistantRoot = resolve(import.meta.dirname, "..");
const commandsDir = resolve(assistantRoot, "src/cli/commands");
const inventoryPath = resolve(assistantRoot, "src/cli/COMMAND_INVENTORY.md");

// ---------------------------------------------------------------------------
// 1. Check that COMMAND_INVENTORY.md exists
// ---------------------------------------------------------------------------

if (!existsSync(inventoryPath)) {
  console.error(
    "✗ COMMAND_INVENTORY.md not found at src/cli/COMMAND_INVENTORY.md",
  );
  console.error(
    "  Create the file and populate it with all commands under src/cli/commands/",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Find all .ts files on disk (excluding __tests__/)
// ---------------------------------------------------------------------------

function findTsFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTsFiles(full, base));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      // Derive command name: strip base prefix and .ts suffix
      // e.g. /abs/path/commands/oauth/connect.ts -> oauth/connect
      const rel = relative(base, full);
      const commandName = rel.replace(/\.ts$/, "");
      results.push(commandName);
    }
  }
  return results;
}

const diskCommands = new Set(findTsFiles(commandsDir, commandsDir));

// ---------------------------------------------------------------------------
// 3. Parse COMMAND_INVENTORY.md to extract command names from the Commands table
// ---------------------------------------------------------------------------

const inventoryContent = readFileSync(inventoryPath, "utf-8");
const lines = inventoryContent.split("\n");

const inventoryCommands = new Set<string>();

// Track whether we are inside the "## Commands" section
let inCommandsSection = false;
// Track whether we have passed the table header in the Commands section
let pastCommandsHeader = false;

for (const line of lines) {
  // Detect section headers
  if (line.startsWith("##")) {
    if (line.trim() === "## Commands") {
      inCommandsSection = true;
      pastCommandsHeader = false;
    } else {
      inCommandsSection = false;
    }
    continue;
  }

  if (!inCommandsSection) continue;

  // Only process table rows (lines starting with |)
  if (!line.startsWith("|")) continue;

  // The first table row in the Commands section is the header ("| Command | ...")
  // The second is the separator ("| --- | ...")
  // We skip both, then collect subsequent rows
  if (!pastCommandsHeader) {
    // Skip header row (contains "Command") and separator row (contains "---")
    if (line.includes("Command") || line.includes("---")) {
      // Once we see the separator row, the next rows are data
      if (line.includes("---")) {
        pastCommandsHeader = true;
      }
      continue;
    }
  }

  // Split row by | and take the second element (index 1, first data column)
  const parts = line.split("|");
  if (parts.length < 2) continue;

  // Strip backticks and whitespace from the first column
  const rawName = parts[1].trim().replace(/`/g, "").trim();
  if (!rawName) continue;

  inventoryCommands.add(rawName);
}

// ---------------------------------------------------------------------------
// 4. Special case: cache-fs was moved to lib/cache-fs.ts (not in commands/)
//    If it appears in inventory but not on disk, that is expected.
// ---------------------------------------------------------------------------

const MOVED_COMMANDS = new Set(["cache-fs"]);

// ---------------------------------------------------------------------------
// 5. Compute mismatches
// ---------------------------------------------------------------------------

const missingFromInventory: string[] = [];
for (const cmd of diskCommands) {
  if (!inventoryCommands.has(cmd)) {
    missingFromInventory.push(cmd);
  }
}

const missingFromDisk: string[] = [];
for (const cmd of inventoryCommands) {
  if (!diskCommands.has(cmd) && !MOVED_COMMANDS.has(cmd)) {
    missingFromDisk.push(cmd);
  }
}

missingFromInventory.sort();
missingFromDisk.sort();

// ---------------------------------------------------------------------------
// 6. Report results
// ---------------------------------------------------------------------------

let hasErrors = false;

if (missingFromInventory.length > 0) {
  hasErrors = true;
  console.error(
    `✗ ${missingFromInventory.length} command file(s) found on disk but missing from COMMAND_INVENTORY.md:`,
  );
  for (const cmd of missingFromInventory) {
    console.error(`    ${cmd}`);
  }
}

if (missingFromDisk.length > 0) {
  hasErrors = true;
  console.error(
    `✗ ${missingFromDisk.length} command(s) in COMMAND_INVENTORY.md but not found on disk:`,
  );
  for (const cmd of missingFromDisk) {
    console.error(`    ${cmd}`);
  }
}

if (hasErrors) {
  console.error(
    "\nFix: ensure every .ts file under src/cli/commands/ (excl. __tests__/) has a row in COMMAND_INVENTORY.md.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 7. Success
// ---------------------------------------------------------------------------

// Count total: disk commands + moved commands that appear in inventory
const inventoryCount = diskCommands.size + MOVED_COMMANDS.size;
console.log(
  `✓ COMMAND_INVENTORY.md is in sync with src/cli/commands/ (${inventoryCount} commands)`,
);
process.exit(0);

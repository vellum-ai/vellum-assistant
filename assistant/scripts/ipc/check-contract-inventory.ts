/**
 * Contract inventory snapshot and drift checker.
 *
 * Parses ipc-protocol.ts to extract the sorted member lists of the
 * ClientMessage and ServerMessage union types, then compares them
 * against a checked-in snapshot JSON.
 *
 * Usage:
 *   bun run ipc:inventory          # check for drift (CI / pre-commit)
 *   bun run ipc:inventory:update   # regenerate the snapshot
 */

import * as fs from "fs";
import * as path from "path";

import {
  type ContractInventory,
  extractInventory,
} from "../../src/daemon/ipc-contract-inventory.js";

const CONTRACT_PATH = path.resolve(
  import.meta.dirname ?? __dirname,
  "../../src/daemon/ipc-protocol.ts",
);

const SNAPSHOT_PATH = path.resolve(
  import.meta.dirname ?? __dirname,
  "../../src/daemon/ipc-contract-inventory.json",
);

/** Load the checked-in snapshot. Returns null if no snapshot exists. */
function loadSnapshot(): ContractInventory | null {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    return null;
  }
  return JSON.parse(
    fs.readFileSync(SNAPSHOT_PATH, "utf-8"),
  ) as ContractInventory;
}

/** Write the snapshot to disk. */
function writeSnapshot(inventory: ContractInventory): void {
  fs.writeFileSync(
    SNAPSHOT_PATH,
    JSON.stringify(inventory, null, 2) + "\n",
    "utf-8",
  );
}

/** Compute a diff between two sorted string arrays. */
function diffArrays(
  label: string,
  expected: string[],
  actual: string[],
): string[] {
  const lines: string[] = [];
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  for (const name of actual) {
    if (!expectedSet.has(name)) {
      lines.push(`  + ${label} added: ${name}`);
    }
  }
  for (const name of expected) {
    if (!actualSet.has(name)) {
      lines.push(`  - ${label} removed: ${name}`);
    }
  }

  return lines;
}

// --- CLI entry point ---

const isUpdate = process.argv.includes("--update");

const inventory = extractInventory(CONTRACT_PATH);

if (isUpdate) {
  writeSnapshot(inventory);
  console.log(
    `Snapshot updated: ${path.relative(process.cwd(), SNAPSHOT_PATH)}`,
  );
  console.log(
    `  ClientMessage members: ${inventory.clientMessageTypes.length}`,
  );
  console.log(
    `  ServerMessage members: ${inventory.serverMessageTypes.length}`,
  );
  process.exit(0);
}

// Check mode
const snapshot = loadSnapshot();

if (!snapshot) {
  console.error(
    "No snapshot found. Run `bun run ipc:inventory:update` to create one.",
  );
  process.exit(1);
}

const diffs: string[] = [
  ...diffArrays(
    "ClientMessage",
    snapshot.clientMessageTypes,
    inventory.clientMessageTypes,
  ),
  ...diffArrays(
    "ServerMessage",
    snapshot.serverMessageTypes,
    inventory.serverMessageTypes,
  ),
  ...diffArrays(
    "ClientWireType",
    snapshot.clientWireTypes,
    inventory.clientWireTypes,
  ),
  ...diffArrays(
    "ServerWireType",
    snapshot.serverWireTypes,
    inventory.serverWireTypes,
  ),
];

if (diffs.length > 0) {
  console.error("IPC contract inventory drift detected:\n");
  for (const line of diffs) {
    console.error(line);
  }
  console.error("\nRun `bun run ipc:inventory:update` to update the snapshot.");
  process.exit(1);
}

console.log("IPC contract inventory is up to date.");

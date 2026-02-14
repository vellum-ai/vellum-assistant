/**
 * CLI entrypoint for the IPC contract inventory checker.
 *
 * Usage:
 *   bun scripts/ipc/check-contract-inventory.ts          # check mode
 *   bun scripts/ipc/check-contract-inventory.ts --update  # update snapshot
 */

import {
  checkInventory,
  extractInventory,
  saveSnapshot,
} from '../../src/daemon/ipc-contract-inventory.js';

const updateMode = process.argv.includes('--update');

if (updateMode) {
  const inventory = extractInventory();
  saveSnapshot(inventory);
  console.log('Snapshot updated.');
  console.log(`  ClientMessage types: ${inventory.clientMessageTypes.length}`);
  console.log(`  ServerMessage types: ${inventory.serverMessageTypes.length}`);
  process.exit(0);
} else {
  const result = checkInventory();
  if (result.ok) {
    console.log('IPC contract inventory matches snapshot.');
    process.exit(0);
  } else {
    console.error(result.diff);
    process.exit(1);
  }
}

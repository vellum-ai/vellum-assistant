import { describe, test, expect } from 'bun:test';
import {
  checkInventory,
  extractInventory,
} from '../daemon/ipc-contract-inventory.js';

describe('IPC contract inventory', () => {
  test('snapshot is up to date', () => {
    const result = checkInventory();
    if (!result.ok) {
      throw new Error(
        result.diff +
          '\n\nTo fix: run `bun run ipc:inventory:update` and commit the updated snapshot.',
      );
    }
    expect(result.ok).toBe(true);
  });

  test('extracts non-empty inventories', () => {
    const inventory = extractInventory();
    expect(inventory.clientMessageTypes.length).toBeGreaterThan(0);
    expect(inventory.serverMessageTypes.length).toBeGreaterThan(0);
  });

  test('inventories are sorted', () => {
    const inventory = extractInventory();
    expect(inventory.clientMessageTypes).toEqual(
      [...inventory.clientMessageTypes].sort(),
    );
    expect(inventory.serverMessageTypes).toEqual(
      [...inventory.serverMessageTypes].sort(),
    );
  });
});

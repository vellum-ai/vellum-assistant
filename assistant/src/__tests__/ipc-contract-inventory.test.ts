import { describe, expect, test } from "bun:test";

import * as fs from "fs";
import * as path from "path";

import {
  type ContractInventory,
  extractInventory,
} from "../daemon/ipc-contract-inventory.js";

const CONTRACT_PATH = path.resolve(
  import.meta.dirname,
  "../daemon/ipc-protocol.ts",
);
const SNAPSHOT_PATH = path.resolve(
  import.meta.dirname,
  "../daemon/ipc-contract-inventory.json",
);

describe("IPC contract inventory", () => {
  test("snapshot file exists", () => {
    expect(fs.existsSync(SNAPSHOT_PATH)).toBe(true);
  });

  test("snapshot matches current contract", () => {
    const snapshot: ContractInventory = JSON.parse(
      fs.readFileSync(SNAPSHOT_PATH, "utf-8"),
    );
    const current = extractInventory(CONTRACT_PATH);

    expect(current.clientMessageTypes).toEqual(snapshot.clientMessageTypes);
    expect(current.serverMessageTypes).toEqual(snapshot.serverMessageTypes);
    expect(current.clientWireTypes).toEqual(snapshot.clientWireTypes);
    expect(current.serverWireTypes).toEqual(snapshot.serverWireTypes);
  });

  test("extracted types are sorted alphabetically", () => {
    const inventory = extractInventory(CONTRACT_PATH);

    const sortedClient = [...inventory.clientMessageTypes].sort();
    const sortedServer = [...inventory.serverMessageTypes].sort();

    expect(inventory.clientMessageTypes).toEqual(sortedClient);
    expect(inventory.serverMessageTypes).toEqual(sortedServer);
  });

  test("ClientMessage and ServerMessage have no overlap", () => {
    const inventory = extractInventory(CONTRACT_PATH);
    const clientSet = new Set(inventory.clientMessageTypes);
    const overlap = inventory.serverMessageTypes.filter((t) =>
      clientSet.has(t),
    );

    expect(overlap).toEqual([]);
  });

  test("all extracted types are non-empty strings", () => {
    const inventory = extractInventory(CONTRACT_PATH);
    const allTypes = [
      ...inventory.clientMessageTypes,
      ...inventory.serverMessageTypes,
    ];

    for (const t of allTypes) {
      expect(typeof t).toBe("string");
      expect(t.length).toBeGreaterThan(0);
    }
  });
});

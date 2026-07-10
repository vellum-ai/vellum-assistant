/**
 * Tests for A2A config handler.
 *
 * Uses the real DB (via `initializeDb()`) and the test preload which sets
 * `VELLUM_WORKSPACE_DIR` to a per-file temp directory.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../../config/loader.js";
import { getSqlite } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { clearA2AConfig, getA2AConfig, setA2AConfig } from "../config-a2a.js";

await initializeDb();

function resetTables(): void {
  const sqlite = getSqlite();
  sqlite.run("DELETE FROM assistant_contact_metadata");
  sqlite.run("DELETE FROM contact_channels");
  sqlite.run("DELETE FROM contacts");
}

function setConfigEnabled(enabled: boolean): void {
  const raw = loadRawConfig();
  setNestedValue(raw, "a2a.enabled", enabled);
  saveRawConfig(raw);
  invalidateConfigCache();
}

describe("getA2AConfig", () => {
  beforeEach(() => {
    resetTables();
    setConfigEnabled(false);
  });

  test("returns enabled: false when a2a is disabled", () => {
    const result = getA2AConfig();
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(false);
    expect(result.activeConnections).toBe(0);
  });

  test("returns enabled: true when a2a is enabled", () => {
    setConfigEnabled(true);
    const result = getA2AConfig();
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
  });
});

describe("setA2AConfig", () => {
  beforeEach(() => {
    resetTables();
    setConfigEnabled(false);
  });

  test("enables a2a in config", () => {
    const result = setA2AConfig();
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
  });

  test("is idempotent", () => {
    setA2AConfig();
    const result = setA2AConfig();
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
  });
});

describe("clearA2AConfig", () => {
  beforeEach(() => {
    resetTables();
    setConfigEnabled(true);
  });

  test("disables a2a in config", () => {
    const result = clearA2AConfig();
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(false);
  });
});

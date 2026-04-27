import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { testSecurityDir } from "./test-preload.js";
import {
  initGatewayDb,
  resetGatewayDb,
  getGatewayDb,
} from "../db/connection.js";
import { autoApproveThresholds } from "../db/schema.js";

// ---------------------------------------------------------------------------
// These tests verify that initGatewayDb handles ambiguous column changes
// (e.g. background+headless → autonomous) without hanging on interactive
// prompts. The pushSchemaNoPrompt wrapper auto-selects "create column".
// ---------------------------------------------------------------------------

const dbPath = join(testSecurityDir, "gateway.sqlite");

function cleanDb(): void {
  resetGatewayDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(dbPath + suffix);
    } catch {
      // file may not exist
    }
  }
}

describe("pushSchemaNoPrompt: auto-resolve ambiguous columns", () => {
  afterEach(cleanDb);

  test("fresh DB — creates schema from scratch without hanging", async () => {
    cleanDb();
    await initGatewayDb();
    // If we got here, no prompt hang occurred
    const db = getGatewayDb();
    const rows = db.select().from(autoApproveThresholds).all();
    // Table exists and is queryable
    expect(rows).toBeInstanceOf(Array);
  });

  test("old schema with background+headless — migrates to autonomous", async () => {
    cleanDb();

    // Pre-seed DB with old schema (background + headless columns)
    const raw = new Database(dbPath);
    raw.exec("PRAGMA journal_mode=WAL");
    raw.exec(`
      CREATE TABLE auto_approve_thresholds (
        id INTEGER PRIMARY KEY DEFAULT 1,
        interactive TEXT NOT NULL DEFAULT 'low',
        background TEXT NOT NULL DEFAULT 'medium',
        headless TEXT NOT NULL DEFAULT 'none',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    raw.exec(`
      INSERT INTO auto_approve_thresholds (id, interactive, background, headless)
      VALUES (1, 'medium', 'low', 'none');
    `);
    raw.close();

    // initGatewayDb should auto-select "create column" for autonomous
    // and not hang on the interactive prompt
    await initGatewayDb();

    // Verify the autonomous column exists and the table is usable
    const db = getGatewayDb();
    const rows = db.select().from(autoApproveThresholds).all();
    expect(rows.length).toBe(1);
    expect(rows[0]).toHaveProperty("autonomous");
  });
});

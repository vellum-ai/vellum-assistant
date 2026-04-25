import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import {
  closeAssistantDb,
  findGuardianForChannelActor,
} from "../auth/guardian-bootstrap.js";

let testRoot: string;

function setupTestDb(): void {
  testRoot = mkdtempSync(join(tmpdir(), "guardian-channel-actor-"));
  const dbDir = join(testRoot, "data", "db");
  mkdirSync(dbDir, { recursive: true });

  const db = new Database(join(dbDir, "assistant.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'contact',
      principal_id TEXT,
      user_file TEXT,
      contact_type TEXT NOT NULL DEFAULT 'human'
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_channels (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      address TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      external_user_id TEXT,
      external_chat_id TEXT,
      status TEXT NOT NULL DEFAULT 'unverified',
      policy TEXT NOT NULL DEFAULT 'allow',
      verified_at INTEGER,
      verified_via TEXT,
      invite_id TEXT,
      revoked_reason TEXT,
      blocked_reason TEXT,
      last_seen_at INTEGER,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      last_interaction INTEGER,
      updated_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  db.close();

  process.env.VELLUM_WORKSPACE_DIR = testRoot;
}

function seedGuardianChannel(args: {
  channelType: string;
  externalUserId: string;
  status?: string;
  principalId?: string;
}): void {
  const dbPath = join(testRoot, "data", "db", "assistant.db");
  const db = new Database(dbPath);
  const now = Date.now();
  const principalId = args.principalId ?? "guardian-principal-001";

  db.run(
    `INSERT INTO contacts
       (id, display_name, role, principal_id, created_at, updated_at)
     VALUES (?, ?, 'guardian', ?, ?, ?)`,
    ["guardian-001", "Test Guardian", principalId, now, now],
  );

  db.run(
    `INSERT INTO contact_channels
       (id, contact_id, type, address, external_user_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      `ch-${args.channelType}-001`,
      "guardian-001",
      args.channelType,
      `${args.channelType}-address`,
      args.externalUserId,
      args.status ?? "active",
      now,
    ],
  );
  db.close();
}

beforeEach(() => {
  setupTestDb();
});

afterEach(() => {
  closeAssistantDb();
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("findGuardianForChannelActor", () => {
  test("returns null when no binding exists", () => {
    expect(findGuardianForChannelActor("slack", "U_UNKNOWN")).toBeNull();
  });

  test("returns principalId for an active slack guardian binding", () => {
    seedGuardianChannel({
      channelType: "slack",
      externalUserId: "U_OWNER",
      principalId: "principal-owner",
    });

    const result = findGuardianForChannelActor("slack", "U_OWNER");
    expect(result).not.toBeNull();
    expect(result?.principalId).toBe("principal-owner");
  });

  test("returns null when the binding is not active", () => {
    seedGuardianChannel({
      channelType: "slack",
      externalUserId: "U_REVOKED",
      status: "revoked",
    });

    expect(findGuardianForChannelActor("slack", "U_REVOKED")).toBeNull();
  });

  test("does not match a different channel type", () => {
    seedGuardianChannel({
      channelType: "telegram",
      externalUserId: "1234",
    });

    // Same external ID but different channel type — should miss
    expect(findGuardianForChannelActor("slack", "1234")).toBeNull();
  });

  test("returns null for empty inputs", () => {
    expect(findGuardianForChannelActor("", "U_OWNER")).toBeNull();
    expect(findGuardianForChannelActor("slack", "")).toBeNull();
  });
});

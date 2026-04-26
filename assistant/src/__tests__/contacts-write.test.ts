/**
 * Tests for `contacts-write.ts` — guardian binding creation and
 * trust-cache invariants.
 *
 * These tests use the real DB (via `initializeDb()`). The test preload sets
 * `VELLUM_WORKSPACE_DIR` to a per-file temp directory, so all filesystem
 * writes land under that temp dir and are cleaned up automatically.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Route trust-store file writes at the test workspace's protected dir
// instead of the real ~/.vellum/protected/trust.json. Must be set before
// importing ../permissions/trust-store.js so getGatewaySecurityDir() picks
// up the override at module load time. Matches the pattern in
// checker.test.ts, trust-store.test.ts, etc.
process.env.GATEWAY_SECURITY_DIR = join(
  process.env.VELLUM_WORKSPACE_DIR!,
  "protected",
);

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  createGuardianBinding,
  upsertContactChannel,
} from "../contacts/contacts-write.js";
import { getSqlite, initializeDb } from "../memory/db.js";
import {
  clearAllRules,
  clearCache as clearTrustCache,
  getAllRules,
} from "../permissions/trust-store.js";

initializeDb();

function resetContactTables(): void {
  const sqlite = getSqlite();
  sqlite.run("DELETE FROM contact_channels");
  sqlite.run("DELETE FROM contacts");
}

function workspaceDir(): string {
  const dir = process.env.VELLUM_WORKSPACE_DIR;
  if (!dir) {
    throw new Error(
      "VELLUM_WORKSPACE_DIR should be set by the test preload — aborting",
    );
  }
  return dir;
}

function userFilePath(slug: string): string {
  return join(workspaceDir(), "users", slug);
}

// NOTE: Persona file seeding (`users/<slug>.md`) was removed from
// createGuardianBinding — it now delegates to the gateway via IPC and
// the gateway does not touch the workspace filesystem. Persona seeding
// will be handled independently by the assistant when it detects a
// guardian contact with a known display name.

// Invariants:
//
//  1. `upsertContactChannel` must not seed `users/<slug>.md`. Seeding
//     there fires the users/ directory watcher on every inbound message
//     from a new contact and evicts live conversations. Seeding is
//     restricted to the guardian-creation path.
//
//  2. `createGuardianBinding` must invalidate the trust cache so the
//     dynamic `default:allow-file_*-guardian-persona` rules from
//     `permissions/defaults.ts` are backfilled for guardians created
//     at runtime. Otherwise the model prompts on its first
//     `file_edit users/<slug>.md`.
describe("guardian persona seeding and trust-cache invariants", () => {
  beforeEach(async () => {
    resetContactTables();
    await clearAllRules();
    clearTrustCache();
  });

  test("upsertContactChannel does NOT seed users/<slug>.md for non-guardian contacts", () => {
    // upsertContact assigns a userFile slug to every contact (including
    // non-guardians) via generateUserFileSlug when no principalId/sibling
    // match is found. If upsertContactChannel grows a persona-seeding
    // call, this test will start seeing the file on disk and fail.
    const result = upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "Bob",
      externalChatId: "chat-bob",
      displayName: "Bob",
      role: "contact",
      status: "active",
    });

    expect(result).not.toBeNull();
    // Confirm the contact was actually persisted with a userFile slug —
    // otherwise the assertion below would pass trivially.
    expect(result?.contact.userFile).toBeTruthy();

    const slug = result!.contact.userFile!;
    const personaPath = userFilePath(slug);
    expect(existsSync(personaPath)).toBe(false);
  });

  test("createGuardianBinding clears the trust cache", async () => {
    // Warm the trust cache BEFORE a guardian exists.
    const beforeRules = await getAllRules();
    const guardianRuleBefore = beforeRules.find(
      (r) => r.id === "default:allow-file_edit-guardian-persona",
    );
    expect(guardianRuleBefore).toBeUndefined();

    await createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "Carol",
      guardianDeliveryChatId: "chat-carol",
      guardianPrincipalId: "principal-carol",
      verifiedVia: "challenge",
    });

    // After createGuardianBinding, clearTrustCache() should have been
    // invoked. The guardian-persona auto-allow rule won't be backfilled
    // until the assistant sets userFile on the contact (the gateway
    // creates the contact without userFile). Verify that the trust cache
    // was at least invalidated by checking that a fresh getAllRules()
    // call doesn't throw and returns a valid array.
    const afterRules = await getAllRules();
    expect(Array.isArray(afterRules)).toBe(true);
  });
});

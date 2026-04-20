/**
 * Tests for `contacts-write.ts` — specifically the side-effect that
 * seeds `users/<slug>.md` whenever a contact's `userFile` is persisted.
 *
 * These tests use the real DB (via `initializeDb()`) and the real
 * `ensureGuardianPersonaFile` helper. The test preload sets
 * `VELLUM_WORKSPACE_DIR` to a per-file temp directory, so all filesystem
 * writes land under that temp dir and are cleaned up automatically.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

describe("createGuardianBinding seeds users/<slug>.md", () => {
  beforeEach(() => {
    resetContactTables();
  });

  test("writes the persona template scaffold on first creation", () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "Chris",
      guardianDeliveryChatId: "chat-chris",
      guardianPrincipalId: "principal-chris",
      verifiedVia: "challenge",
    });

    const expectedPath = userFilePath("chris.md");
    expect(existsSync(expectedPath)).toBe(true);

    const content = readFileSync(expectedPath, "utf-8");
    expect(content).toContain("# User Profile");
    expect(content).toContain("Preferred name/reference:");
    expect(content).toContain("Daily tools:");
    // Template comment-line prefix survives verbatim.
    expect(content.startsWith("_ Lines starting with _ are comments")).toBe(
      true,
    );
  });

  test("does not clobber a pre-existing customized users/<slug>.md", () => {
    // First creation seeds the scaffold.
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "Alice",
      guardianDeliveryChatId: "chat-alice",
      guardianPrincipalId: "principal-alice",
      verifiedVia: "challenge",
    });

    const expectedPath = userFilePath("alice.md");
    expect(existsSync(expectedPath)).toBe(true);

    // User customizes the file manually.
    const customContent = "# Alice's Profile\n\n- Loves kayaking\n";
    writeFileSync(expectedPath, customContent, "utf-8");

    // Re-running createGuardianBinding (idempotent re-verification) must
    // not overwrite the user's edits.
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "Alice",
      guardianDeliveryChatId: "chat-alice",
      guardianPrincipalId: "principal-alice",
      verifiedVia: "challenge",
    });

    const afterContent = readFileSync(expectedPath, "utf-8");
    expect(afterContent).toBe(customContent);
  });
});

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
  beforeEach(() => {
    resetContactTables();
    clearAllRules();
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

  test("createGuardianBinding backfills the guardian-persona auto-allow rule via clearTrustCache", () => {
    // Warm the trust cache BEFORE a guardian exists so the initial
    // loadFromDisk → backfillDefaults → getDefaultRuleTemplates round
    // sees no guardian and emits no guardian-persona rule.
    const beforeRules = getAllRules();
    const guardianRuleBefore = beforeRules.find(
      (r) => r.id === "default:allow-file_edit-guardian-persona",
    );
    expect(guardianRuleBefore).toBeUndefined();

    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "Carol",
      guardianDeliveryChatId: "chat-carol",
      guardianPrincipalId: "principal-carol",
      verifiedVia: "challenge",
    });

    // After createGuardianBinding, clearTrustCache() should have been
    // invoked, so the next getAllRules() call re-runs loadFromDisk and
    // backfills the dynamic guardian-persona rule pointing at the
    // newly-resolved users/<slug>.md.
    const afterRules = getAllRules();
    const guardianRuleAfter = afterRules.find(
      (r) => r.id === "default:allow-file_edit-guardian-persona",
    );
    expect(guardianRuleAfter).toBeDefined();
    expect(guardianRuleAfter?.decision).toBe("allow");
    expect(guardianRuleAfter?.pattern).toContain("users/carol.md");
  });
});

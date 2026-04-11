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

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { createGuardianBinding } from "../contacts/contacts-write.js";
import { getSqlite, initializeDb } from "../memory/db.js";

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
      guardianExternalUserId: "Sidd",
      guardianDeliveryChatId: "chat-sidd",
      guardianPrincipalId: "principal-sidd",
      verifiedVia: "challenge",
    });

    const expectedPath = userFilePath("sidd.md");
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

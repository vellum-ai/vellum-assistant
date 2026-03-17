import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(
  join(tmpdir(), "guardian-binding-drift-heal-test-"),
);

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { findGuardianForChannel } from "../contacts/contact-store.js";
import { createGuardianBinding } from "../contacts/contacts-write.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { healGuardianBindingDrift } from "../runtime/guardian-vellum-migration.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
}

describe("healGuardianBindingDrift", () => {
  beforeEach(() => {
    resetTables();
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  });

  test("heals drift when both principals have vellum-principal- prefix", () => {
    // Simulate DB reset: new guardian binding with a different UUID
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "vellum-principal-new-uuid",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "vellum-principal-new-uuid",
      verifiedVia: "startup-migration",
    });

    // Client arrives with the old JWT principal
    const healed = healGuardianBindingDrift("vellum-principal-old-uuid");
    expect(healed).toBe(true);

    // Guardian binding now matches the old JWT
    const guardian = findGuardianForChannel("vellum");
    expect(guardian).not.toBeNull();
    expect(guardian!.contact.principalId).toBe("vellum-principal-old-uuid");
    expect(guardian!.channel.externalUserId).toBe("vellum-principal-old-uuid");
  });

  test("no-op when principals already match", () => {
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "vellum-principal-same",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "vellum-principal-same",
      verifiedVia: "startup-migration",
    });

    const healed = healGuardianBindingDrift("vellum-principal-same");
    expect(healed).toBe(false);
  });

  test("refuses to heal when incoming principal lacks vellum-principal- prefix", () => {
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "vellum-principal-aaa",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "vellum-principal-aaa",
      verifiedVia: "startup-migration",
    });

    // External/platform principal — should NOT be adopted
    const healed = healGuardianBindingDrift("platform-user-12345");
    expect(healed).toBe(false);

    // Guardian unchanged
    const guardian = findGuardianForChannel("vellum");
    expect(guardian!.contact.principalId).toBe("vellum-principal-aaa");
  });

  test("refuses to heal when stored principal lacks vellum-principal- prefix", () => {
    createGuardianBinding({
      channel: "vellum",
      guardianExternalUserId: "verified-phone-guardian",
      guardianDeliveryChatId: "local",
      guardianPrincipalId: "verified-phone-guardian",
      verifiedVia: "challenge",
    });

    // Even with a vellum-principal- incoming, don't overwrite a real binding
    const healed = healGuardianBindingDrift("vellum-principal-attacker");
    expect(healed).toBe(false);

    const guardian = findGuardianForChannel("vellum");
    expect(guardian!.contact.principalId).toBe("verified-phone-guardian");
  });

  test("returns false when no guardian binding exists", () => {
    const healed = healGuardianBindingDrift("vellum-principal-orphan");
    expect(healed).toBe(false);
  });
});

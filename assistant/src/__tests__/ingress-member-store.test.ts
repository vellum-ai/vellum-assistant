import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "ingress-member-store-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
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

import { getSqlite, resetDb } from '../memory/db-connection.js';
import { initializeDb } from '../memory/db-init.js';
import {
  findMember,
  listMembers,
  updateLastSeen,
  upsertMember,
} from "../memory/ingress-member-store.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

function resetMembersTable() {
  getSqlite().run("DELETE FROM assistant_ingress_members");
}

describe("ingress-member-store: multi-assistant isolation", () => {
  beforeEach(() => {
    resetMembersTable();
  });

  test("upsertMember for assistant A does not create a member for assistant B", () => {
    upsertMember({
      assistantId: "assistant-a",
      sourceChannel: "telegram",
      externalUserId: "user-1",
      status: "active",
      policy: "allow",
    });

    const memberA = findMember({
      assistantId: "assistant-a",
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });
    const memberB = findMember({
      assistantId: "assistant-b",
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });

    expect(memberA).not.toBeNull();
    expect(memberA!.assistantId).toBe("assistant-a");
    expect(memberB).toBeNull();
  });

  test("findMember with assistantId A does not return members from assistantId B", () => {
    upsertMember({
      assistantId: "assistant-a",
      sourceChannel: "telegram",
      externalUserId: "user-1",
      status: "active",
      policy: "allow",
    });
    upsertMember({
      assistantId: "assistant-b",
      sourceChannel: "telegram",
      externalUserId: "user-1",
      status: "active",
      policy: "deny",
    });

    const memberA = findMember({
      assistantId: "assistant-a",
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });
    const memberB = findMember({
      assistantId: "assistant-b",
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });

    expect(memberA).not.toBeNull();
    expect(memberA!.policy).toBe("allow");
    expect(memberB).not.toBeNull();
    expect(memberB!.policy).toBe("deny");
    expect(memberA!.id).not.toBe(memberB!.id);
  });

  test("upsertMember for same user across two assistants creates separate records", () => {
    const memberA = upsertMember({
      assistantId: "assistant-a",
      sourceChannel: "telegram",
      externalUserId: "user-x",
      displayName: "User X for A",
      status: "active",
      policy: "allow",
    });

    const memberB = upsertMember({
      assistantId: "assistant-b",
      sourceChannel: "telegram",
      externalUserId: "user-x",
      displayName: "User X for B",
      status: "pending",
      policy: "escalate",
    });

    expect(memberA.id).not.toBe(memberB.id);
    expect(memberA.assistantId).toBe("assistant-a");
    expect(memberB.assistantId).toBe("assistant-b");
    expect(memberA.displayName).toBe("User X for A");
    expect(memberB.displayName).toBe("User X for B");
    expect(memberA.status).toBe("active");
    expect(memberB.status).toBe("pending");
    expect(memberA.policy).toBe("allow");
    expect(memberB.policy).toBe("escalate");
  });

  test("listMembers filtered by assistantId only returns that assistant members", () => {
    upsertMember({
      assistantId: "assistant-a",
      sourceChannel: "telegram",
      externalUserId: "user-1",
      status: "active",
      policy: "allow",
    });
    upsertMember({
      assistantId: "assistant-a",
      sourceChannel: "telegram",
      externalUserId: "user-2",
      status: "active",
      policy: "allow",
    });
    upsertMember({
      assistantId: "assistant-b",
      sourceChannel: "telegram",
      externalUserId: "user-3",
      status: "active",
      policy: "allow",
    });

    const membersA = listMembers({ assistantId: "assistant-a" });
    const membersB = listMembers({ assistantId: "assistant-b" });

    expect(membersA).toHaveLength(2);
    expect(membersA.every((m) => m.assistantId === "assistant-a")).toBe(true);
    expect(membersB).toHaveLength(1);
    expect(membersB[0].assistantId).toBe("assistant-b");
    expect(membersB[0].externalUserId).toBe("user-3");
  });

  test('listMembers defaults to assistantId "self" when not specified', () => {
    upsertMember({
      sourceChannel: "telegram",
      externalUserId: "user-default",
      status: "active",
      policy: "allow",
    });
    upsertMember({
      assistantId: "other-assistant",
      sourceChannel: "telegram",
      externalUserId: "user-other",
      status: "active",
      policy: "allow",
    });

    const defaultMembers = listMembers();
    expect(defaultMembers).toHaveLength(1);
    expect(defaultMembers[0].assistantId).toBe("self");
    expect(defaultMembers[0].externalUserId).toBe("user-default");
  });

  test("upsertMember updates existing record within same assistant, not across assistants", () => {
    upsertMember({
      assistantId: "assistant-a",
      sourceChannel: "telegram",
      externalUserId: "user-1",
      displayName: "Original Name",
      status: "active",
      policy: "allow",
    });
    upsertMember({
      assistantId: "assistant-b",
      sourceChannel: "telegram",
      externalUserId: "user-1",
      displayName: "Name for B",
      status: "active",
      policy: "allow",
    });

    // Update within assistant-a should not affect assistant-b's record
    const updatedA = upsertMember({
      assistantId: "assistant-a",
      sourceChannel: "telegram",
      externalUserId: "user-1",
      displayName: "Updated Name for A",
    });

    expect(updatedA.displayName).toBe("Updated Name for A");

    const memberB = findMember({
      assistantId: "assistant-b",
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });
    expect(memberB).not.toBeNull();
    expect(memberB!.displayName).toBe("Name for B");
  });

  test("updateLastSeen does not cross assistant boundaries", () => {
    const memberA = upsertMember({
      assistantId: "assistant-a",
      sourceChannel: "telegram",
      externalUserId: "user-1",
      status: "active",
      policy: "allow",
    });
    const memberB = upsertMember({
      assistantId: "assistant-b",
      sourceChannel: "telegram",
      externalUserId: "user-1",
      status: "active",
      policy: "allow",
    });

    expect(memberA.lastSeenAt).toBeNull();
    expect(memberB.lastSeenAt).toBeNull();

    updateLastSeen(memberA.id);

    const refreshedA = findMember({
      assistantId: "assistant-a",
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });
    const refreshedB = findMember({
      assistantId: "assistant-b",
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });

    expect(refreshedA!.lastSeenAt).not.toBeNull();
    expect(refreshedB!.lastSeenAt).toBeNull();
  });

  test("findMember with externalChatId also scopes by assistantId", () => {
    upsertMember({
      assistantId: "assistant-a",
      sourceChannel: "telegram",
      externalChatId: "chat-100",
      status: "active",
      policy: "allow",
    });

    const foundA = findMember({
      assistantId: "assistant-a",
      sourceChannel: "telegram",
      externalChatId: "chat-100",
    });
    const foundB = findMember({
      assistantId: "assistant-b",
      sourceChannel: "telegram",
      externalChatId: "chat-100",
    });

    expect(foundA).not.toBeNull();
    expect(foundB).toBeNull();
  });
});

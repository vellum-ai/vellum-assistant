import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import {
  isModeSessionRecoveryHealthy,
  isSessionGroupsEnabled,
  setModeSessionRecoveryHealthy,
} from "../config/session-groups-gate.js";
import {
  getDbMigrationReadiness,
  setDbMigrating,
  setDbReady,
} from "../daemon/daemon-readiness.js";
import { recoverModeSessionsBeforeDbReady } from "../daemon/mode-session-startup-recovery.js";
import {
  beginConversationModeSession,
  finalizeConversationModeSession,
  getConversationModeSession,
  recoverActiveConversationModeSessions,
  updateConversationModeSessionActivity,
} from "../persistence/conversation-mode-sessions.js";
import { migrateCreateConversationModeSessions } from "../persistence/migrations/381-create-conversation-mode-sessions.js";
import * as schema from "../persistence/schema.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

afterEach(() => {
  setDbReady(true);
  setModeSessionRecoveryHealthy(true);
  setOverridesForTesting({});
});

function createStore() {
  const sqlite = new Database(":memory:");
  sqlite.exec(/* sql */ `
    PRAGMA foreign_keys = ON;
    CREATE TABLE conversations (id TEXT PRIMARY KEY);
    INSERT INTO conversations (id) VALUES ('conv-123');
  `);
  const db = drizzle(sqlite, { schema });
  migrateCreateConversationModeSessions(db);
  return { db, options: { db } };
}

describe("mode session startup recovery", () => {
  test("publishes readiness only after recovery succeeds", () => {
    setDbMigrating();
    let readinessDuringRecovery = getDbMigrationReadiness();

    const result = recoverModeSessionsBeforeDbReady(() => {
      readinessDuringRecovery = getDbMigrationReadiness();
      return 2;
    });

    expect(readinessDuringRecovery).toMatchObject({
      ready: false,
      state: "running",
    });
    expect(result).toEqual({ ok: true, interruptedCount: 2 });
    expect(getDbMigrationReadiness()).toEqual({
      ready: true,
      state: "ready",
    });
  });

  test.each([false, true])(
    "keeps ordinary work ready after recovery fails with flag %s",
    (enabled) => {
      setOverridesForTesting({ "session-groups": enabled });
      setDbMigrating();
      const recoveryError = new Error("recovery failed");
      const result = recoverModeSessionsBeforeDbReady(() => {
        throw recoveryError;
      });
      expect(result).toEqual({ ok: false, error: recoveryError });
      expect(getDbMigrationReadiness()).toEqual({
        ready: true,
        state: "ready",
      });
      expect(isModeSessionRecoveryHealthy()).toBe(false);
      expect(isSessionGroupsEnabled()).toBe(false);
      setOverridesForTesting({ "session-groups": true });
      expect(isSessionGroupsEnabled()).toBe(false);
      setDbMigrating();
      expect(recoverModeSessionsBeforeDbReady(() => 1)).toEqual({
        ok: true,
        interruptedCount: 1,
      });
      expect(isSessionGroupsEnabled()).toBe(true);
    },
  );

  test("interrupts active records without fabricating an end time", () => {
    const { options } = createStore();
    beginConversationModeSession(
      {
        id: "session-active",
        conversationId: "conv-123",
        mode: "browser",
        sourceStartedAt: 100,
      },
      options,
    );
    updateConversationModeSessionActivity(
      {
        id: "session-active",
        conversationId: "conv-123",
        expectedRevision: 1,
        lastActivityAt: 140,
        lastOwnedMessageId: "message-123",
      },
      options,
    );

    expect(recoverActiveConversationModeSessions(options)).toBe(1);
    expect(
      getConversationModeSession("conv-123", "session-active", options),
    ).toMatchObject({
      status: "interrupted",
      lastActivityAt: 140,
      lastOwnedMessageId: "message-123",
      endedAt: null,
      endReason: "assistant_restarted",
      revision: 3,
    });
    expect(recoverActiveConversationModeSessions(options)).toBe(0);
  });

  test("preserves terminal truth and prevents an old callback from reopening it", () => {
    const { options } = createStore();
    beginConversationModeSession(
      {
        id: "session-completed",
        conversationId: "conv-123",
        mode: "computer_use",
        sourceStartedAt: 100,
      },
      options,
    );
    finalizeConversationModeSession(
      {
        id: "session-completed",
        conversationId: "conv-123",
        expectedRevision: 1,
        status: "completed",
        endedAt: 150,
        endReason: "settled",
      },
      options,
    );

    expect(recoverActiveConversationModeSessions(options)).toBe(0);
    expect(
      updateConversationModeSessionActivity(
        {
          id: "session-completed",
          conversationId: "conv-123",
          expectedRevision: 2,
          lastActivityAt: 200,
        },
        options,
      ),
    ).toMatchObject({
      ok: false,
      reason: "terminal",
      session: { status: "completed", endedAt: 150, revision: 2 },
    });
  });

  test("recovered work can only continue under a fresh session id", () => {
    const { options } = createStore();
    beginConversationModeSession(
      {
        id: "session-before-restart",
        conversationId: "conv-123",
        mode: "browser",
        sourceStartedAt: 100,
      },
      options,
    );
    recoverModeSessionsBeforeDbReady(() => {
      throw new Error("recovery unavailable");
    });
    expect(
      getConversationModeSession("conv-123", "session-before-restart", options)
        ?.status,
    ).toBe("active");
    setDbMigrating();
    expect(
      recoverModeSessionsBeforeDbReady(() =>
        recoverActiveConversationModeSessions(options),
      ),
    ).toEqual({ ok: true, interruptedCount: 1 });

    expect(
      beginConversationModeSession(
        {
          id: "session-before-restart",
          conversationId: "conv-123",
          mode: "browser",
          sourceStartedAt: 200,
        },
        options,
      ),
    ).toMatchObject({ ok: false, reason: "already_exists" });
    expect(
      beginConversationModeSession(
        {
          id: "session-after-restart",
          conversationId: "conv-123",
          mode: "browser",
          sourceStartedAt: 200,
        },
        options,
      ),
    ).toMatchObject({
      ok: true,
      session: { id: "session-after-restart", status: "active", revision: 1 },
    });
  });
});

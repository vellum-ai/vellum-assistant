import { beforeEach, expect, mock, test } from "bun:test";

const resident = {
  hasInFlightWork: mock(() => false),
  inFlightSendRequestIds: new Set<string>(),
  pendingStandaloneSurfaces: new Set<string>(),
};
let hasResident = false;
let pendingInput = false;
let pendingBackground = false;
let hasManager = false;
let states:
  | Array<{ id: string; parentConversationId: string; status: string }>
  | undefined = [];
let activeAndPendingIds: string[] = [];
mock.module("../../daemon/conversation-registry.js", () => ({
  findConversation: () => (hasResident ? resident : undefined),
}));
mock.module("../../runtime/pending-interactions.js", () => ({
  getByConversation: () => (pendingInput ? [{}] : []),
}));
mock.module("../../notifications/has-pending-background-work.js", () => ({
  hasPendingBackgroundWork: () => pendingBackground,
}));
mock.module("../../acp/index.js", () => ({
  peekAcpSessionManager: () =>
    hasManager
      ? {
          getStatus: () => states,
          getActiveAndPendingIds: () => activeAndPendingIds,
        }
      : undefined,
}));

import {
  beginTurnFinalization,
  resetTurnFinalizationsForTesting,
} from "../../daemon/turn-finalization.js";
import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { acpSessionHistory } from "../../persistence/schema/index.js";
import { hasAutoArchiveBlockingWork } from "../auto-archive-activity.js";

await initializeDb();
const ID = "conv-123";
beforeEach(() => {
  hasResident = pendingInput = pendingBackground = hasManager = false;
  resident.hasInFlightWork.mockReturnValue(false);
  resident.inFlightSendRequestIds.clear();
  resident.pendingStandaloneSurfaces.clear();
  states = [];
  activeAndPendingIds = [];
  resetTurnFinalizationsForTesting();
  getDb().delete(acpSessionHistory).run();
});

test("inactive nonresident and idle resident chats have no runtime blockers", () => {
  expect(hasAutoArchiveBlockingWork(ID)).toBe(false);
  hasResident = true;
  expect(hasAutoArchiveBlockingWork(ID)).toBe(false);
});

for (const blocker of [
  "in-flight",
  "accepted-send",
  "standalone-surface",
  "input",
  "background",
  "finalization",
]) {
  test(`${blocker} work blocks automatic Done`, () => {
    hasResident = true;
    if (blocker === "in-flight") {
      resident.hasInFlightWork.mockReturnValue(true);
    }
    if (blocker === "accepted-send") {
      resident.inFlightSendRequestIds.add("request-123");
    }
    if (blocker === "standalone-surface") {
      resident.pendingStandaloneSurfaces.add("surface-123");
    }
    if (blocker === "input") {
      pendingInput = true;
    }
    if (blocker === "background") {
      pendingBackground = true;
    }
    if (blocker === "finalization") {
      beginTurnFinalization(ID);
    }
    expect(hasAutoArchiveBlockingWork(ID)).toBe(true);
  });
}

test("settled turn finalization releases its blocker", () => {
  const settle = beginTurnFinalization(ID);
  expect(hasAutoArchiveBlockingWork(ID)).toBe(true);
  settle();
  expect(hasAutoArchiveBlockingWork(ID)).toBe(false);
});

test("live ACP state protects only its parent and terminal state does not block", () => {
  hasManager = true;
  states = [{ id: "session-123", parentConversationId: ID, status: "running" }];
  expect(hasAutoArchiveBlockingWork(ID)).toBe(true);
  expect(hasAutoArchiveBlockingWork("conv-other")).toBe(false);
  states[0]!.status = "completed";
  expect(hasAutoArchiveBlockingWork(ID)).toBe(false);
});

test("ACP resume reservations protect terminal history before live registration", () => {
  hasManager = true;
  activeAndPendingIds = ["session-123"];
  getDb()
    .insert(acpSessionHistory)
    .values({
      id: "session-123",
      parentConversationId: ID,
      agentId: "agent-123",
      acpSessionId: "session-123",
      task: "Example task",
      status: "completed",
      startedAt: 1,
    })
    .run();
  expect(hasAutoArchiveBlockingWork(ID)).toBe(true);
  expect(hasAutoArchiveBlockingWork("conv-other")).toBe(false);
  activeAndPendingIds = [];
  expect(hasAutoArchiveBlockingWork(ID)).toBe(false);
});

test("uncertain ACP status fails closed", () => {
  hasManager = true;
  states = undefined;
  expect(hasAutoArchiveBlockingWork(ID)).toBe(true);
});

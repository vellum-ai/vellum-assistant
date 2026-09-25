import { afterEach, beforeEach, expect, jest, mock, test } from "bun:test";

import { SYNC_TAGS } from "../../daemon/message-types/sync.js";
import type { AutoArchiveCandidate } from "../../persistence/conversation-auto-archive.js";

const config = {
  conversations: { autoArchive: { enabled: false, afterDays: 7 } },
};
let ready = true;
let startupComplete = true;
let doneEnabled = true;
let rows: AutoArchiveCandidate[] = [];
let callback:
  | ((event: { message: { type: string; tags: string[] } }) => void)
  | undefined;
const dispose = mock(() => {
  callback = undefined;
});
const list = mock(
  ({
    after,
    limit,
  }: {
    after?: AutoArchiveCandidate;
    limit: number;
    cutoff: number;
  }) => rows.filter((row) => !after || row.id > after.id).slice(0, limit),
);
const archive = mock(
  (candidate: AutoArchiveCandidate, _cutoff: number, _now: number) => {
    rows = rows.filter((row) => row.id !== candidate.id);
    return true;
  },
);
const guardian = mock(
  async (): Promise<Array<{ sourceConversationId: string }>> => [],
);
const blocked = mock((_id: string) => false);
const publish = mock((_reason: string, _ids: string[]) => {});

mock.module("../../config/loader.js", () => ({ getConfig: () => config }));
mock.module("../../config/sidebar-done-gate.js", () => ({
  isSidebarDoneEnabled: () => doneEnabled,
}));
mock.module("../../daemon/daemon-readiness.js", () => ({
  getDbMigrationReadiness: () => ({ ready }),
  isStartupComplete: () => startupComplete,
}));
mock.module("../../persistence/conversation-auto-archive.js", () => ({
  listAutoArchiveCandidates: list,
  archiveInactiveConversation: archive,
}));
mock.module("../../channels/gateway-guardian-requests.js", () => ({
  listGuardianRequests: guardian,
}));
mock.module("../auto-archive-activity.js", () => ({
  hasAutoArchiveBlockingWork: blocked,
}));
mock.module("../../runtime/sync/resource-sync-events.js", () => ({
  publishConversationListAndMetadataChanged: publish,
}));
mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    subscribe: (input: { callback: typeof callback }) => {
      callback = input.callback;
      return { dispose, active: true, connectionId: "test" };
    },
  },
}));

import { ConversationAutoArchiveWorker } from "../auto-archive.js";

let worker: ConversationAutoArchiveWorker;
const HOUR = 3_600_000;
function seed(count = 1) {
  rows = Array.from({ length: count }, (_, index) => ({
    id: `conv-${String(index).padStart(4, "0")}`,
    createdAt: 1,
    lastMessageAt: 1,
    lastReopenedAt: null,
    activityAt: 1,
  }));
}
async function settle() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}
async function startIdle() {
  worker.start();
  await settle();
  config.conversations.autoArchive.enabled = true;
}

beforeEach(() => {
  config.conversations.autoArchive = { enabled: false, afterDays: 7 };
  ready = startupComplete = doneEnabled = true;
  seed();
  list.mockClear();
  archive.mockReset().mockImplementation((candidate) => {
    rows = rows.filter((row) => row.id !== candidate.id);
    return true;
  });
  guardian.mockReset().mockResolvedValue([]);
  blocked.mockReset().mockReturnValue(false);
  publish.mockClear();
  dispose.mockClear();
  worker = new ConversationAutoArchiveWorker();
});
afterEach(() => {
  worker.stop();
  jest.useRealTimers();
});

test("disabled, unavailable Done, migration readiness and startup gates never query candidates", async () => {
  worker.start();
  await settle();
  expect(list).not.toHaveBeenCalled();
  config.conversations.autoArchive.enabled = true;
  for (const gate of ["ready", "startup", "done"]) {
    ready = gate !== "ready";
    startupComplete = gate !== "startup";
    doneEnabled = gate !== "done";
    await worker.requestSweep();
  }
  expect(list).not.toHaveBeenCalled();
});

test("startup waits for interrupted conversation recovery and marks eligible chats once", async () => {
  const recovery = Promise.withResolvers<void>();
  config.conversations.autoArchive.enabled = true;
  worker.start(recovery.promise);
  await worker.requestSweep();
  expect(list).not.toHaveBeenCalled();
  recovery.resolve();
  await settle();
  await worker.requestSweep();
  expect(archive).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledWith("reordered", ["conv-0000"]);
  expect(list.mock.calls[0]?.[0].cutoff).toBeGreaterThan(
    Date.now() - 7 * 24 * HOUR - 100,
  );
});

test("shutdown before recovery resolves cannot start a sweep", async () => {
  const recovery = Promise.withResolvers<void>();
  config.conversations.autoArchive.enabled = true;
  worker.start(recovery.promise);
  worker.stop();
  recovery.resolve();
  await settle();
  expect(list).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("failed startup recovery keeps the worker paused", async () => {
  worker.start(Promise.reject(new Error("recovery failed")));
  config.conversations.autoArchive.enabled = true;
  await settle();
  await worker.requestSweep();
  expect(list).not.toHaveBeenCalled();
});

test("pending guardian input and live activity skip only affected chats", async () => {
  await startIdle();
  seed(3);
  guardian.mockResolvedValue([{ sourceConversationId: "conv-0000" }]);
  blocked.mockImplementation((id) => id === "conv-0001");
  await worker.requestSweep();
  expect(archive.mock.calls.map(([candidate]) => candidate.id)).toEqual([
    "conv-0002",
  ]);
  expect(guardian).toHaveBeenCalledWith({ status: "pending" });
});

test("an unavailable gateway leaves the entire candidate page unchanged", async () => {
  await startIdle();
  guardian.mockRejectedValue(new Error("gateway unavailable"));
  await worker.requestSweep();
  expect(archive).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});

for (const change of ["disable", "threshold", "shutdown"]) {
  test(`${change} during the gateway read prevents the sampled write`, async () => {
    await startIdle();
    const pending =
      Promise.withResolvers<Array<{ sourceConversationId: string }>>();
    guardian.mockImplementation(() => pending.promise);
    const sweep = worker.requestSweep();
    if (change === "disable") {
      config.conversations.autoArchive.enabled = false;
    }
    if (change === "threshold") {
      config.conversations.autoArchive.afterDays = 30;
    }
    if (change === "shutdown") {
      worker.stop();
    }
    pending.resolve([]);
    await sweep;
    expect(archive).not.toHaveBeenCalled();
  });
}

test("SQLite retry rechecks activity before it attempts another write", async () => {
  await startIdle();
  archive.mockImplementationOnce(() => {
    blocked.mockReturnValue(true);
    throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
  });
  await worker.requestSweep();
  expect(blocked).toHaveBeenCalledTimes(2);
  expect(archive).toHaveBeenCalledTimes(1);
  expect(publish).not.toHaveBeenCalled();
});

test("a later write error still invalidates chats committed earlier in the page", async () => {
  await startIdle();
  seed(3);
  archive.mockImplementation((candidate) => {
    if (candidate.id === "conv-0001") {
      throw new Error("write failed");
    }
    return true;
  });
  await worker.requestSweep();
  expect(archive).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenCalledWith("reordered", ["conv-0000"]);
});

test("pages batch invalidations and fetch pending input per bounded page", async () => {
  await startIdle();
  seed(205);
  await worker.requestSweep();
  expect(archive).toHaveBeenCalledTimes(205);
  expect(guardian).toHaveBeenCalledTimes(3);
  expect(publish.mock.calls.map(([, ids]) => ids.length)).toEqual([
    100, 100, 5,
  ]);
});

test("overlapping triggers coalesce without overlapping gateway reads", async () => {
  await startIdle();
  const pending =
    Promise.withResolvers<Array<{ sourceConversationId: string }>>();
  guardian.mockImplementationOnce(() => pending.promise);
  const first = worker.requestSweep();
  expect(worker.requestSweep()).toBe(first);
  expect(worker.requestSweep()).toBe(first);
  expect(guardian).toHaveBeenCalledTimes(1);
  pending.resolve([]);
  await first;
  await settle();
  expect(archive).toHaveBeenCalledTimes(1);
  expect(list).toHaveBeenCalledTimes(2);
});

test("config invalidation and hourly cadence trigger sweeps and stop releases both", async () => {
  jest.useFakeTimers();
  await startIdle();
  callback?.({
    message: { type: "sync_changed", tags: [SYNC_TAGS.assistantConfig] },
  });
  await settle();
  expect(archive).toHaveBeenCalledTimes(1);
  seed();
  jest.advanceTimersByTime(HOUR - 1);
  await settle();
  expect(archive).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(1);
  await settle();
  expect(archive).toHaveBeenCalledTimes(2);
  worker.stop();
  seed();
  jest.advanceTimersByTime(HOUR);
  await settle();
  expect(archive).toHaveBeenCalledTimes(2);
  expect(callback).toBeUndefined();
});

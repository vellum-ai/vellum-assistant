import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  setSystemTime,
  test,
} from "bun:test";

let mockClient: {
  baseUrl: string;
  platformAssistantId: string;
  fetch: (path: string, init: RequestInit) => Promise<Response>;
} | null;

mock.module("./client.js", () => ({
  VellumPlatformClient: { create: async () => mockClient },
}));

import { getLogger } from "../util/logger.js";
import {
  createPlatformPatchQueue,
  type SyncedKey,
} from "./platform-patch-queue.js";

interface Patch {
  path: string;
  body: { value: string };
}

let patches: Patch[];
let respond: () => Response;
let builds: number;
let queues: Array<{ dispose: () => void }>;

function makeClient(assistantId = "asst-1", baseUrl = "https://platform.a") {
  return {
    baseUrl,
    platformAssistantId: assistantId,
    fetch: async (path: string, init: RequestInit) => {
      patches.push({ path, body: JSON.parse(init.body as string) });
      return respond();
    },
  };
}

function makeQueue(
  opts: {
    loadSyncedKey?: () => SyncedKey | null;
    saveSyncedKey?: (synced: SyncedKey) => void;
    maxAgeMs?: number;
    retryDelaysMs?: number[];
  } = {},
) {
  const queue = createPlatformPatchQueue<string | undefined>({
    log: getLogger("test"),
    label: "value",
    buildPayload: (value) => {
      builds += 1;
      return value === undefined ? undefined : { key: value, body: { value } };
    },
    ...opts,
  });
  queues.push(queue);
  return queue;
}

const FROZEN_NOW = new Date("2026-01-01T00:00:00.000Z").getTime();

/**
 * Flush already-queued microtasks. Fake timers stop the clock but not the
 * promise chain `enqueue` appends onto, so the PATCH work a timer kicks off
 * lands here.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

/** Advance `Date.now()` and the queue's `setTimeout` handles together. */
async function elapse(ms: number): Promise<void> {
  setSystemTime(new Date(Date.now() + ms));
  jest.advanceTimersByTime(ms);
  await settle();
}

describe("createPlatformPatchQueue", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    setSystemTime(new Date(FROZEN_NOW));
    patches = [];
    builds = 0;
    respond = () => new Response("{}", { status: 200 });
    mockClient = makeClient();
    queues = [];
  });

  afterEach(() => {
    for (const queue of queues) {
      queue.dispose();
    }
    jest.useRealTimers();
    setSystemTime();
  });

  test("PATCHes once and dedups an unchanged key", async () => {
    const queue = makeQueue();
    queue.enqueue("a");
    await settle();
    queue.enqueue("a");
    await settle();

    expect(patches).toEqual([
      { path: "/v1/assistants/asst-1/", body: { value: "a" } },
    ]);
  });

  test("re-registering to another assistant id or base URL re-sends", async () => {
    const queue = makeQueue();
    queue.enqueue("a");
    await settle();
    mockClient = makeClient("asst-2");
    queue.enqueue("a");
    await settle();
    mockClient = makeClient("asst-2", "https://platform.b");
    queue.enqueue("a");
    await settle();
    queue.enqueue("a");
    await settle();

    expect(patches.map((p) => p.path)).toEqual([
      "/v1/assistants/asst-1/",
      "/v1/assistants/asst-2/",
      "/v1/assistants/asst-2/",
    ]);
  });

  test("rapid enqueues collapse into one PATCH carrying the newest payload", async () => {
    const queue = makeQueue();
    queue.enqueue("a");
    queue.enqueue("b");
    queue.enqueue("c");
    await settle();

    expect(patches.map((p) => p.body.value)).toEqual(["c"]);
    expect(builds).toBe(1);
  });

  test("an undefined payload, missing client, or missing assistant id skips", async () => {
    const queue = makeQueue();
    queue.enqueue(undefined);
    await settle();
    mockClient = null;
    queue.enqueue("a");
    await settle();
    mockClient = makeClient("");
    queue.enqueue("a");
    await settle();

    expect(patches).toHaveLength(0);
    expect(builds).toBe(1);
  });

  test("a failed PATCH does not dedup the next attempt", async () => {
    const queue = makeQueue();
    respond = () => new Response("nope", { status: 500 });
    queue.enqueue("a");
    await settle();
    respond = () => new Response("{}", { status: 200 });
    queue.enqueue("a");
    await settle();
    queue.enqueue("a");
    await settle();

    expect(patches).toHaveLength(2);
  });

  test("a thrown fetch is swallowed and retried on the next enqueue", async () => {
    const queue = makeQueue();
    mockClient = {
      ...makeClient(),
      fetch: async () => {
        throw new Error("boom");
      },
    };
    queue.enqueue("a");
    await settle();
    mockClient = makeClient();
    queue.enqueue("a");
    await settle();

    expect(patches).toHaveLength(1);
  });

  test("seeds the dedup key from loadSyncedKey and saves each success", async () => {
    const saved: SyncedKey[] = [];
    const queue = makeQueue({
      loadSyncedKey: () => ({
        key: "https://platform.a|asst-1|a",
        syncedAt: Date.now(),
      }),
      saveSyncedKey: (synced) => saved.push(synced),
    });
    queue.enqueue("a");
    await settle();
    queue.enqueue("b");
    await settle();

    expect(patches.map((p) => p.body.value)).toEqual(["b"]);
    expect(saved).toEqual([
      { key: "https://platform.a|asst-1|b", syncedAt: expect.any(Number) },
    ]);
  });

  test("a matching key older than maxAgeMs re-sends in-process", async () => {
    const saved: SyncedKey[] = [];
    const queue = makeQueue({
      maxAgeMs: 1000,
      saveSyncedKey: (synced) => saved.push(synced),
    });
    const start = Date.now();
    queue.enqueue("a");
    await settle();
    setSystemTime(new Date(start + 999));
    queue.enqueue("a");
    await settle();
    setSystemTime(new Date(start + 1000));
    queue.enqueue("a");
    await settle();
    queue.enqueue("a");
    await settle();

    expect(patches).toHaveLength(2);
    expect(saved.map((s) => s.syncedAt)).toEqual([start, start + 1000]);
  });

  test("a seeded key older than maxAgeMs re-sends", async () => {
    const queue = makeQueue({
      maxAgeMs: 1000,
      loadSyncedKey: () => ({
        key: "https://platform.a|asst-1|a",
        syncedAt: Date.now() - 1000,
      }),
    });
    queue.enqueue("a");
    await settle();

    expect(patches).toHaveLength(1);
  });

  test("re-sends at expiry with no enqueue call, and dispose cancels that", async () => {
    const queue = makeQueue({ maxAgeMs: 300 });
    queue.enqueue("a");
    await settle();
    expect(patches).toHaveLength(1);

    await elapse(300);
    expect(patches).toHaveLength(2);
    expect(builds).toBe(2);

    queue.dispose();
    await elapse(300);
    expect(patches).toHaveLength(2);
  });

  test("a seeded, still-fresh key arms the expiry re-send", async () => {
    const queue = makeQueue({
      maxAgeMs: 300,
      loadSyncedKey: () => ({
        key: "https://platform.a|asst-1|a",
        syncedAt: Date.now(),
      }),
    });
    queue.enqueue("a");
    await settle();
    expect(patches).toHaveLength(0);

    await elapse(300);
    expect(patches).toHaveLength(1);
  });

  test("a failed PATCH retries on backoff and dedups after the retry succeeds", async () => {
    const queue = makeQueue({ retryDelaysMs: [100, 100, 100] });
    respond = () => new Response("nope", { status: 500 });
    queue.enqueue("a");
    await settle();
    expect(patches).toHaveLength(1);

    respond = () => new Response("{}", { status: 200 });
    await elapse(100);
    expect(patches).toHaveLength(2);

    await elapse(100);
    queue.enqueue("a");
    await settle();
    expect(patches).toHaveLength(2);
  });

  test("a thrown fetch retries on backoff", async () => {
    const queue = makeQueue({ retryDelaysMs: [100] });
    mockClient = {
      ...makeClient(),
      fetch: async () => {
        throw new Error("boom");
      },
    };
    queue.enqueue("a");
    await settle();
    mockClient = makeClient();
    await elapse(100);

    expect(patches).toHaveLength(1);
  });

  test("retries stop once the backoff schedule is exhausted", async () => {
    const queue = makeQueue({ retryDelaysMs: [50, 50] });
    respond = () => new Response("nope", { status: 500 });
    queue.enqueue("a");
    await settle();
    await elapse(50);
    await elapse(50);
    expect(patches).toHaveLength(3);

    await elapse(100);
    expect(patches).toHaveLength(3);
  });

  test("a new enqueue during backoff supersedes the retry and resets the bound", async () => {
    const queue = makeQueue({ retryDelaysMs: [100] });
    respond = () => new Response("nope", { status: 500 });
    queue.enqueue("a");
    await settle();
    queue.enqueue("b");
    await settle();
    expect(patches.map((p) => p.body.value)).toEqual(["a", "b"]);

    await elapse(100);
    expect(patches.map((p) => p.body.value)).toEqual(["a", "b", "b"]);

    await elapse(100);
    expect(patches).toHaveLength(3);
  });

  test("dispose cancels a pending retry", async () => {
    const queue = makeQueue({ retryDelaysMs: [300] });
    respond = () => new Response("nope", { status: 500 });
    queue.enqueue("a");
    await settle();
    queue.dispose();
    await elapse(300);

    expect(patches).toHaveLength(1);
  });

  test("without maxAgeMs a matching key never expires", async () => {
    const queue = makeQueue({
      loadSyncedKey: () => ({
        key: "https://platform.a|asst-1|a",
        syncedAt: 0,
      }),
    });
    queue.enqueue("a");
    await settle();

    expect(patches).toHaveLength(0);
  });
});

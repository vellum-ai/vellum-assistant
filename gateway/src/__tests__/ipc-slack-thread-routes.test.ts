import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { type Socket } from "node:net";

import {
  getGatewayDb,
  initGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { SlackStore } from "../db/slack-store.js";
import { slackActiveThreads } from "../db/schema.js";
import { GatewayIpcServer } from "../ipc/server.js";
import { slackThreadRoutes } from "../ipc/slack-thread-handlers.js";
import { connectClient, sendRequest } from "./helpers/ipc-newline-client.js";

const CHANNEL_ID = "CFAKE00001";
const OTHER_CHANNEL_ID = "COTHER0001";
const THREAD_TS = "1700000000.000000";
const OTHER_THREAD_TS = "1700000001.000000";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  getGatewayDb().delete(slackActiveThreads).run();
});

afterAll(() => {
  resetGatewayDb();
});

function activeThreadRows(): Array<{ threadTs: string; channelId: string }> {
  return new SlackStore(getGatewayDb()).listActiveThreadsWithChannel();
}

function rawActiveThreadRows(): Array<{
  threadTs: string;
  channelId: string | null;
}> {
  const rawDb = (getGatewayDb() as unknown as { $client: unknown }).$client as {
    prepare: (sql: string) => {
      all: () => Array<{ thread_ts: string; channel_id: string | null }>;
    };
  };
  return rawDb
    .prepare("SELECT thread_ts, channel_id FROM slack_active_threads")
    .all()
    .map((row) => ({
      threadTs: row.thread_ts,
      channelId: row.channel_id,
    }));
}

function trackThread(): void {
  new SlackStore(getGatewayDb()).trackThread(THREAD_TS, CHANNEL_ID, 60_000);
}

function trackLegacyThreadWithoutChannel(): void {
  const rawDb = (getGatewayDb() as unknown as { $client: unknown }).$client as {
    prepare: (sql: string) => { run: (...params: unknown[]) => void };
  };
  rawDb
    .prepare(
      "INSERT INTO slack_active_threads (thread_ts, channel_id, tracked_at, expires_at) VALUES (?, NULL, ?, ?)",
    )
    .run(THREAD_TS, Date.now(), Date.now() + 60_000);
}

describe("IPC Slack thread routes", () => {
  let server: InstanceType<typeof GatewayIpcServer>;
  let client: Socket;

  afterEach(() => {
    client?.destroy();
    server?.stop();
  });

  async function startServerAndConnect(): Promise<void> {
    server = new GatewayIpcServer([...slackThreadRoutes]);
    server.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    client = await connectClient(server.getSocketPath());
  }

  test("detach_slack_active_thread removes a matching active thread", async () => {
    trackThread();

    await startServerAndConnect();
    const res = await sendRequest(client, "detach_slack_active_thread", {
      channelId: CHANNEL_ID,
      threadTs: THREAD_TS,
    });

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      detached: true,
      channelId: CHANNEL_ID,
      threadTs: THREAD_TS,
    });
    expect(activeThreadRows()).toEqual([]);
    // The row survives as an explicit-detach marker so the bot's own
    // follow-up posts (e.g. a mute confirmation echo) cannot re-arm the
    // thread, while no longer counting as actively tracked.
    const store = new SlackStore(getGatewayDb());
    expect(store.hasThread(THREAD_TS)).toBe(false);
    expect(store.isThreadDetached(THREAD_TS)).toBe(true);
  });

  test("detach_slack_active_thread is idempotent for an unknown thread", async () => {
    trackThread();

    await startServerAndConnect();
    const res = await sendRequest(client, "detach_slack_active_thread", {
      channelId: CHANNEL_ID,
      threadTs: OTHER_THREAD_TS,
    });

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      detached: false,
      channelId: CHANNEL_ID,
      threadTs: OTHER_THREAD_TS,
    });
    expect(activeThreadRows()).toEqual([
      { threadTs: THREAD_TS, channelId: CHANNEL_ID },
    ]);
    // Even a never-tracked thread gets a marker, so a confirmation the
    // bot posts after an "already muted" acknowledgement cannot arm it.
    expect(
      new SlackStore(getGatewayDb()).isThreadDetached(OTHER_THREAD_TS),
    ).toBe(true);
  });

  test("detach_slack_active_thread detaches a legacy active thread without channel", async () => {
    trackLegacyThreadWithoutChannel();

    await startServerAndConnect();
    const res = await sendRequest(client, "detach_slack_active_thread", {
      channelId: CHANNEL_ID,
      threadTs: THREAD_TS,
    });

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      detached: true,
      channelId: CHANNEL_ID,
      threadTs: THREAD_TS,
    });
    // The legacy row is converted into an explicit-detach marker (now
    // carrying the caller's channel) instead of being deleted.
    expect(activeThreadRows()).toEqual([]);
    expect(rawActiveThreadRows()).toEqual([
      { threadTs: THREAD_TS, channelId: CHANNEL_ID },
    ]);
    const store = new SlackStore(getGatewayDb());
    expect(store.hasThread(THREAD_TS)).toBe(false);
    expect(store.isThreadDetached(THREAD_TS)).toBe(true);
  });

  test("detach_slack_active_thread does not remove channel mismatches", async () => {
    trackThread();

    await startServerAndConnect();
    const res = await sendRequest(client, "detach_slack_active_thread", {
      channelId: OTHER_CHANNEL_ID,
      threadTs: THREAD_TS,
    });

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      detached: false,
      channelId: OTHER_CHANNEL_ID,
      threadTs: THREAD_TS,
    });
    expect(activeThreadRows()).toEqual([
      { threadTs: THREAD_TS, channelId: CHANNEL_ID },
    ]);
  });
});

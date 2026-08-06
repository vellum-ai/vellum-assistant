import {
  afterEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

import {
  beginCheckpointReconnectHoldoff,
  clearCheckpointReconnectHoldoff,
} from "../checkpoint-reconnect-holdoff.js";
import { SlackSocketModeClient } from "../slack/socket-mode.js";

type ReplacementClientHarness = {
  running: boolean;
  connecting: boolean;
  ws: WebSocket | null;
  connect(): Promise<void>;
  getWebSocketUrl(): Promise<string>;
  scheduleReconnect(): void;
};

function makeReplacementClient(): {
  client: ReplacementClientHarness;
  getWebSocketUrl: ReturnType<typeof mock<() => Promise<string>>>;
  scheduleReconnect: ReturnType<typeof mock<() => void>>;
} {
  const client = Object.create(
    SlackSocketModeClient.prototype,
  ) as ReplacementClientHarness;
  const getWebSocketUrl = mock(async () => {
    throw new Error("stop after testing reconnect admission");
  });
  const scheduleReconnect = mock(() => {});
  Object.assign(client, {
    running: true,
    connecting: false,
    ws: null,
    getWebSocketUrl,
    scheduleReconnect,
  });
  return { client, getWebSocketUrl, scheduleReconnect };
}

afterEach(() => {
  clearCheckpointReconnectHoldoff();
  setSystemTime();
});

describe("Slack checkpoint reconnect holdoff", () => {
  test("blocks a replacement client until wake clears the holdoff", async () => {
    const { client, getWebSocketUrl, scheduleReconnect } =
      makeReplacementClient();

    beginCheckpointReconnectHoldoff();
    await client.connect();

    expect(getWebSocketUrl).toHaveBeenCalledTimes(0);
    expect(scheduleReconnect).toHaveBeenCalledTimes(1);

    clearCheckpointReconnectHoldoff();
    await client.connect();

    expect(getWebSocketUrl).toHaveBeenCalledTimes(1);
    expect(scheduleReconnect).toHaveBeenCalledTimes(2);
  });

  test("lets a replacement client retry after the holdoff expires", async () => {
    const checkpointStartedAt = Date.parse("2026-01-01T00:00:00Z");
    setSystemTime(new Date(checkpointStartedAt));
    beginCheckpointReconnectHoldoff();

    setSystemTime(new Date(checkpointStartedAt + 60_001));
    const { client, getWebSocketUrl } = makeReplacementClient();
    await client.connect();

    expect(getWebSocketUrl).toHaveBeenCalledTimes(1);
  });
});

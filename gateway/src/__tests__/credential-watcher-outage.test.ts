import { beforeEach, describe, expect, mock, test } from "bun:test";

import "./test-preload.js";

type ServiceCredentialsRead =
  | { status: "ok"; credentials: Record<string, string> }
  | { status: "missing" }
  | { status: "unreachable" };

const specs = [
  { service: "telegram", requiredFields: ["bot_token", "webhook_secret"] },
  { service: "vellum", requiredFields: ["platform_assistant_id"] },
] as const;

const reads = new Map<string, ServiceCredentialsRead>();

const actualCredentialReader = await import("../credential-reader.js");
mock.module("../credential-reader.js", () => ({
  ...actualCredentialReader,
  ALL_CREDENTIAL_SPECS: specs,
  getCesHttpConfig: () => undefined,
  readServiceCredentialsResult: async (spec: { service: string }) =>
    reads.get(spec.service) ?? { status: "missing" as const },
}));

const { CredentialWatcher } = await import("../credential-watcher.js");

const TELEGRAM_CREDS = {
  bot_token: "bot-token",
  webhook_secret: "webhook-secret",
};

beforeEach(() => {
  reads.clear();
});

describe("CredentialWatcher keeps last-known credentials on vault outage", () => {
  test("does not emit a clear when a previously loaded service becomes unreachable", async () => {
    const events: Array<{
      services: string[];
      telegram: Record<string, string> | null | undefined;
    }> = [];
    const watcher = new CredentialWatcher((event) => {
      events.push({
        services: [...event.changedServices],
        telegram: event.credentials.get("telegram"),
      });
    });

    reads.set("telegram", { status: "ok", credentials: TELEGRAM_CREDS });
    await watcher._pollOnceForTest();
    expect(events).toEqual([
      { services: ["telegram"], telegram: TELEGRAM_CREDS },
    ]);

    reads.set("telegram", { status: "unreachable" });
    await watcher._pollOnceForTest();
    expect(events).toHaveLength(1);

    reads.set("telegram", { status: "missing" });
    await watcher._pollOnceForTest();
    expect(events).toEqual([
      { services: ["telegram"], telegram: TELEGRAM_CREDS },
      { services: ["telegram"], telegram: null },
    ]);
  });

  test("still emits a genuine credential update", async () => {
    const events: Array<Record<string, string> | null | undefined> = [];
    const watcher = new CredentialWatcher((event) => {
      events.push(event.credentials.get("telegram"));
    });

    reads.set("telegram", { status: "ok", credentials: TELEGRAM_CREDS });
    await watcher._pollOnceForTest();

    const rotated = {
      bot_token: "rotated-bot-token",
      webhook_secret: "rotated-webhook-secret",
    };
    reads.set("telegram", { status: "ok", credentials: rotated });
    await watcher._pollOnceForTest();

    expect(events).toEqual([TELEGRAM_CREDS, rotated]);
  });
});

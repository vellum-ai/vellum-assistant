import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  ConfigFileWatcher,
  type ConfigChangeEvent,
} from "../config-file-watcher.js";
import {
  isOnlyVelayPublicBaseUrlChange,
  shouldSyncTwilioPhoneWebhooksAfterConfigChange,
} from "../twilio/webhook-sync-trigger.js";
import { testWorkspaceDir } from "./test-preload.js";

const configPath = join(testWorkspaceDir, "config.json");

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(configPath, JSON.stringify(data), "utf-8");
}

function pollOnce(watcher: ConfigFileWatcher): void {
  (
    watcher as unknown as {
      pollOnce: () => void;
    }
  ).pollOnce();
}

function makeEvent(
  changedKeys: string[],
  changedFields: Record<string, string[]>,
): ConfigChangeEvent {
  return {
    data: {},
    changedKeys: new Set(changedKeys),
    changedFields: new Map(
      Object.entries(changedFields).map(([section, fields]) => [
        section,
        new Set(fields),
      ]),
    ),
  };
}

afterEach(() => {
  try {
    if (existsSync(configPath)) unlinkSync(configPath);
  } catch {
    // best-effort cleanup
  }
});

describe("ConfigFileWatcher", () => {
  test("reports shallow ingress fields changed by Velay-managed URL writes", () => {
    writeConfig({
      ingress: {
        publicBaseUrl: "https://public.example.test",
      },
    });
    const events: ConfigChangeEvent[] = [];
    const watcher = new ConfigFileWatcher((event) => {
      events.push(event);
    });

    pollOnce(watcher);
    writeConfig({
      ingress: {
        publicBaseUrl: "https://velay.example.test",
        publicBaseUrlManagedBy: "velay",
      },
    });
    pollOnce(watcher);

    expect(events).toHaveLength(2);
    expect(events[1].changedKeys).toEqual(new Set(["ingress"]));
    expect(events[1].changedFields.get("ingress")).toEqual(
      new Set(["publicBaseUrl", "publicBaseUrlManagedBy"]),
    );
  });

  test("reports Twilio-only fields when Velay creates ingress from scratch", () => {
    writeConfig({
      gateway: {
        runtimeProxyRequireAuth: false,
      },
    });
    const events: ConfigChangeEvent[] = [];
    const watcher = new ConfigFileWatcher((event) => {
      events.push(event);
    });

    pollOnce(watcher);
    writeConfig({
      gateway: {
        runtimeProxyRequireAuth: false,
      },
      ingress: {
        publicBaseUrl: "https://velay.example.test",
        publicBaseUrlManagedBy: "velay",
      },
    });
    pollOnce(watcher);

    expect(events).toHaveLength(2);
    expect(events[1].changedKeys).toEqual(new Set(["ingress"]));
    expect(events[1].changedFields.get("ingress")).toEqual(
      new Set(["publicBaseUrl", "publicBaseUrlManagedBy"]),
    );
  });

  test("detects public base URL changes", () => {
    writeConfig({
      ingress: {
        publicBaseUrl: "https://old-public.example.test",
        publicBaseUrlManagedBy: "velay",
      },
    });
    const events: ConfigChangeEvent[] = [];
    const watcher = new ConfigFileWatcher((event) => {
      events.push(event);
    });

    pollOnce(watcher);
    writeConfig({
      ingress: {
        publicBaseUrl: "https://new-public.example.test",
        publicBaseUrlManagedBy: "velay",
      },
    });
    pollOnce(watcher);

    expect(events).toHaveLength(2);
    expect(events[1].changedFields.get("ingress")).toEqual(
      new Set(["publicBaseUrl"]),
    );
  });
});

describe("Twilio webhook sync config-change triggers", () => {
  test("syncs when generic public ingress changes without a Twilio override", () => {
    const event = makeEvent(["ingress"], { ingress: ["publicBaseUrl"] });

    expect(isOnlyVelayPublicBaseUrlChange(event)).toBe(false);
    expect(shouldSyncTwilioPhoneWebhooksAfterConfigChange(event)).toBe(true);
  });

  test("syncs when Velay-managed public ingress changes", () => {
    const event = makeEvent(["ingress"], {
      ingress: ["publicBaseUrl", "publicBaseUrlManagedBy"],
    });

    expect(isOnlyVelayPublicBaseUrlChange(event)).toBe(true);
    expect(shouldSyncTwilioPhoneWebhooksAfterConfigChange(event)).toBe(true);
  });

  test("does not sync when only the Velay manager marker changes", () => {
    const event = makeEvent(["ingress"], {
      ingress: ["publicBaseUrlManagedBy"],
    });

    expect(isOnlyVelayPublicBaseUrlChange(event)).toBe(true);
    expect(shouldSyncTwilioPhoneWebhooksAfterConfigChange(event)).toBe(false);
  });

  test("syncs when Twilio phone configuration becomes available", () => {
    const event = makeEvent(["twilio"], {
      twilio: ["phoneNumber", "accountSid"],
    });

    expect(isOnlyVelayPublicBaseUrlChange(event)).toBe(false);
    expect(shouldSyncTwilioPhoneWebhooksAfterConfigChange(event)).toBe(true);
  });

  test("does not sync when unrelated Twilio configuration changes", () => {
    const event = makeEvent(["twilio"], {
      twilio: ["assistantPhoneNumbers"],
    });

    expect(shouldSyncTwilioPhoneWebhooksAfterConfigChange(event)).toBe(false);
  });
});

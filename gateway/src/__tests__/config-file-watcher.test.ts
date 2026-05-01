import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  ConfigFileWatcher,
  type ConfigChangeEvent,
} from "../config-file-watcher.js";
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

afterEach(() => {
  try {
    if (existsSync(configPath)) unlinkSync(configPath);
  } catch {
    // best-effort cleanup
  }
});

describe("ConfigFileWatcher", () => {
  test("reports shallow ingress fields changed by Velay-managed Twilio URL writes", () => {
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
        publicBaseUrl: "https://public.example.test",
        twilioPublicBaseUrl: "https://velay.example.test",
        twilioPublicBaseUrlManagedBy: "velay",
      },
    });
    pollOnce(watcher);

    expect(events).toHaveLength(2);
    expect(events[1].changedKeys).toEqual(new Set(["ingress"]));
    expect(events[1].changedFields.get("ingress")).toEqual(
      new Set(["twilioPublicBaseUrl", "twilioPublicBaseUrlManagedBy"]),
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
        twilioPublicBaseUrl: "https://velay.example.test",
        twilioPublicBaseUrlManagedBy: "velay",
      },
    });
    pollOnce(watcher);

    expect(events).toHaveLength(2);
    expect(events[1].changedKeys).toEqual(new Set(["ingress"]));
    expect(events[1].changedFields.get("ingress")).toEqual(
      new Set(["twilioPublicBaseUrl", "twilioPublicBaseUrlManagedBy"]),
    );
  });

  test("distinguishes public ingress URL changes from Twilio-only changes", () => {
    writeConfig({
      ingress: {
        publicBaseUrl: "https://old-public.example.test",
        twilioPublicBaseUrl: "https://velay.example.test",
        twilioPublicBaseUrlManagedBy: "velay",
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
        twilioPublicBaseUrl: "https://velay.example.test",
        twilioPublicBaseUrlManagedBy: "velay",
      },
    });
    pollOnce(watcher);

    expect(events).toHaveLength(2);
    expect(events[1].changedFields.get("ingress")).toEqual(
      new Set(["publicBaseUrl"]),
    );
  });
});

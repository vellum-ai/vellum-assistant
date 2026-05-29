import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";

import type { AssistantEntry } from "../assistant-config.js";
import type { LifecycleReporter } from "../lifecycle-reporter.js";

import * as realAssistantConfig from "../assistant-config.js";

const loadAllAssistantsMock = mock<() => AssistantEntry[]>(() => []);

mock.module("../assistant-config.js", () => ({
  ...realAssistantConfig,
  loadAllAssistants: loadAllAssistantsMock,
}));

const { retireLocal } = await import("../retire-local.js");

afterAll(() => {
  mock.module("../assistant-config.js", () => realAssistantConfig);
});

function makeEntry(assistantId: string, instanceDir: string): AssistantEntry {
  return {
    assistantId,
    runtimeUrl: "http://127.0.0.1:7821",
    cloud: "local",
    resources: {
      instanceDir,
      daemonPort: 7801,
      gatewayPort: 7831,
      qdrantPort: 6334,
      cesPort: 7790,
    },
  };
}

function makeRecordingReporter(): {
  reporter: LifecycleReporter;
  logs: string[];
} {
  const logs: string[] = [];
  return {
    logs,
    reporter: {
      progress: () => {},
      log: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  };
}

describe("retireLocal", () => {
  test("keeps shared data dir, returns structured result, and routes output to the injected reporter", async () => {
    const shared = "/tmp/vellum-retire-shared-instance";
    const target = makeEntry("assistant-a", shared);
    loadAllAssistantsMock.mockReturnValue([
      target,
      makeEntry("assistant-b", shared),
    ]);

    const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    const { reporter, logs } = makeRecordingReporter();

    const result = await retireLocal("assistant-a", target, reporter);

    expect(result).toEqual({
      assistantId: "assistant-a",
      archived: false,
      sharedDataDir: true,
    });
    expect(
      logs.some((line) => line.includes("config entry removed only")),
    ).toBe(true);
    expect(consoleLogSpy).not.toHaveBeenCalled();

    consoleLogSpy.mockRestore();
  });

  test("throws when the entry is missing resource configuration", async () => {
    const entry = {
      ...makeEntry("assistant-c", "/tmp/x"),
      resources: undefined,
    };

    await expect(retireLocal("assistant-c", entry)).rejects.toThrow(
      "missing resource configuration",
    );
  });
});

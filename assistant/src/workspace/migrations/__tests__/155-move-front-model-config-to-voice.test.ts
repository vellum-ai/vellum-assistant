import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { moveFrontModelConfigToVoiceMigration } from "../155-move-front-model-config-to-voice.js";

function workspaceWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "move-front-model-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  return dir;
}

function readConfig(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("155-move-front-model-config-to-voice", () => {
  test("moves liveVoice.frontModel under voice and leaves the rest of liveVoice", () => {
    const dir = workspaceWith({
      liveVoice: {
        vad: { silenceThresholdMs: 900 },
        frontModel: {
          endpointDecisionTimeoutMs: 300,
          progress: { idleIntervalMs: 4_000 },
        },
      },
    });

    moveFrontModelConfigToVoiceMigration.run(dir);

    expect(readConfig(dir)).toEqual({
      liveVoice: { vad: { silenceThresholdMs: 900 } },
      voice: {
        frontModel: {
          endpointDecisionTimeoutMs: 300,
          progress: { idleIntervalMs: 4_000 },
        },
      },
    });
  });

  test("an existing voice.frontModel wins field by field", () => {
    const dir = workspaceWith({
      liveVoice: {
        frontModel: {
          endpointDecisionTimeoutMs: 300,
          endpointMaxExtensions: 1,
          progress: { idleIntervalMs: 4_000, minGapMs: 2_000 },
        },
      },
      voice: {
        frontModel: {
          endpointDecisionTimeoutMs: 800,
          progress: { idleIntervalMs: 7_000 },
        },
      },
    });

    moveFrontModelConfigToVoiceMigration.run(dir);

    expect(readConfig(dir)).toEqual({
      liveVoice: {},
      voice: {
        frontModel: {
          endpointDecisionTimeoutMs: 800,
          endpointMaxExtensions: 1,
          progress: { idleIntervalMs: 7_000, minGapMs: 2_000 },
        },
      },
    });
  });

  test("a config without the old key is left untouched", () => {
    const dir = workspaceWith({ liveVoice: { archiveAudio: true } });
    const before = readFileSync(join(dir, "config.json"), "utf8");

    moveFrontModelConfigToVoiceMigration.run(dir);

    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(before);
  });

  test("is idempotent", () => {
    const dir = workspaceWith({
      liveVoice: { frontModel: { endpointExtensionMs: 2_000 } },
    });

    moveFrontModelConfigToVoiceMigration.run(dir);
    const once = readConfig(dir);
    moveFrontModelConfigToVoiceMigration.run(dir);

    expect(readConfig(dir)).toEqual(once);
  });

  test("a missing config file is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "move-front-model-empty-"));
    expect(() => moveFrontModelConfigToVoiceMigration.run(dir)).not.toThrow();
  });
});

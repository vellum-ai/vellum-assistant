import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before imports that depend on platform/logger
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function ensureTestDir(): void {
  const dirs = [
    WORKSPACE_DIR,
    join(WORKSPACE_DIR, "data"),
    join(WORKSPACE_DIR, "data", "memory"),
    join(WORKSPACE_DIR, "data", "memory", "knowledge"),
    join(WORKSPACE_DIR, "data", "logs"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

import { run } from "../config/bundled-skills/settings/tools/voice-config-update.js";
import { invalidateConfigCache } from "../config/loader.js";
import type { ToolContext } from "../tools/types.js";
import { listCatalogProviderIds } from "../tts/provider-catalog.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj));
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    conversationId: "test-conv",
    turnId: "test-turn",
    sendToClient: overrides?.sendToClient ?? (() => {}),
    ...overrides,
  } as ToolContext;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  ensureTestDir();
  writeConfig({});
  invalidateConfigCache();
});

afterEach(() => {
  try {
    writeConfig({});
    invalidateConfigCache();
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Tests: tts_provider persists to canonical path only
// ---------------------------------------------------------------------------

describe("voice_config_update — tts_provider", () => {
  test("persists tts_provider to canonical services.tts.provider", async () => {
    writeConfig({});
    invalidateConfigCache();

    const result = await run(
      { setting: "tts_provider", value: "fish-audio" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const config = readConfig();
    expect((config.services as any)?.tts?.provider).toBe("fish-audio");
  });

  test("does not write to legacy calls.voice.ttsProvider", async () => {
    writeConfig({});
    invalidateConfigCache();

    const result = await run(
      { setting: "tts_provider", value: "fish-audio" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const config = readConfig();
    expect((config.calls as any)?.voice?.ttsProvider).toBeUndefined();
  });

  test("rejects invalid tts_provider", async () => {
    const result = await run(
      { setting: "tts_provider", value: "invalid-provider" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("tts_provider must be one of");
  });

  test("broadcasts ttsProvider to client", async () => {
    const messages: any[] = [];
    const ctx = makeContext({
      sendToClient: (msg: any) => messages.push(msg),
    });

    await run({ setting: "tts_provider", value: "elevenlabs" }, ctx);

    expect(messages).toHaveLength(1);
    expect(messages[0].key).toBe("ttsProvider");
    expect(messages[0].value).toBe("elevenlabs");
  });
});

// ---------------------------------------------------------------------------
// Tests: tts_voice_id persists to canonical path only
// ---------------------------------------------------------------------------

describe("voice_config_update — tts_voice_id", () => {
  test("persists to canonical services.tts.providers.elevenlabs.voiceId", async () => {
    writeConfig({});
    invalidateConfigCache();

    const result = await run(
      { setting: "tts_voice_id", value: "abc123" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const config = readConfig();
    expect((config.services as any)?.tts?.providers?.elevenlabs?.voiceId).toBe(
      "abc123",
    );
  });

  test("does not write to legacy elevenlabs.voiceId", async () => {
    writeConfig({});
    invalidateConfigCache();

    const result = await run(
      { setting: "tts_voice_id", value: "abc123" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const config = readConfig();
    expect((config.elevenlabs as any)?.voiceId).toBeUndefined();
  });

  test("rejects non-alphanumeric voice ID", async () => {
    const result = await run(
      { setting: "tts_voice_id", value: "abc-123!" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("alphanumeric");
  });
});

// ---------------------------------------------------------------------------
// Tests: fish_audio_reference_id persists to canonical path only
// ---------------------------------------------------------------------------

describe("voice_config_update — fish_audio_reference_id", () => {
  test("persists to canonical services.tts.providers.fish-audio.referenceId", async () => {
    writeConfig({});
    invalidateConfigCache();

    const result = await run(
      { setting: "fish_audio_reference_id", value: "voice-ref-123" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const config = readConfig();
    expect(
      (config.services as any)?.tts?.providers?.["fish-audio"]?.referenceId,
    ).toBe("voice-ref-123");
  });

  test("does not write to legacy fishAudio.referenceId", async () => {
    writeConfig({});
    invalidateConfigCache();

    const result = await run(
      { setting: "fish_audio_reference_id", value: "voice-ref-123" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const config = readConfig();
    expect((config.fishAudio as any)?.referenceId).toBeUndefined();
  });

  test("rejects empty reference ID", async () => {
    const result = await run(
      { setting: "fish_audio_reference_id", value: "" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("non-empty string");
  });
});

// ---------------------------------------------------------------------------
// Tests: conversation_timeout persists to canonical path only
// ---------------------------------------------------------------------------

describe("voice_config_update — conversation_timeout", () => {
  test("persists to canonical services.tts.providers.elevenlabs.conversationTimeoutSeconds", async () => {
    writeConfig({});
    invalidateConfigCache();

    const result = await run(
      { setting: "conversation_timeout", value: 15 },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const config = readConfig();
    expect(
      (config.services as any)?.tts?.providers?.elevenlabs
        ?.conversationTimeoutSeconds,
    ).toBe(15);
  });

  test("does not write to legacy elevenlabs.conversationTimeoutSeconds", async () => {
    writeConfig({});
    invalidateConfigCache();

    const result = await run(
      { setting: "conversation_timeout", value: 15 },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const config = readConfig();
    expect(
      (config.elevenlabs as any)?.conversationTimeoutSeconds,
    ).toBeUndefined();
  });

  test("rejects invalid timeout", async () => {
    const result = await run(
      { setting: "conversation_timeout", value: 42 },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("conversation_timeout must be one of");
  });
});

// ---------------------------------------------------------------------------
// Tests: validation edge cases
// ---------------------------------------------------------------------------

describe("voice_config_update — validation", () => {
  test("missing setting returns error", async () => {
    const result = await run({ value: "test" }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("setting");
  });

  test("missing value returns error", async () => {
    const result = await run({ setting: "tts_provider" }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("value");
  });

  test("unknown setting returns error", async () => {
    const result = await run(
      { setting: "unknown_setting", value: "test" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown setting");
  });
});

// ---------------------------------------------------------------------------
// Tests: catalog-driven provider validation
// ---------------------------------------------------------------------------

describe("voice_config_update — catalog-driven provider validation", () => {
  test("accepts every provider ID in the catalog", async () => {
    const catalogIds = listCatalogProviderIds();
    expect(catalogIds.length).toBeGreaterThanOrEqual(1);

    for (const id of catalogIds) {
      writeConfig({});
      invalidateConfigCache();

      const result = await run(
        { setting: "tts_provider", value: id },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("updated to");
    }
  });

  test("rejects provider IDs not in the catalog", async () => {
    const bogusIds = ["nonexistent-provider", "google-tts", "amazon-polly", ""];

    for (const id of bogusIds) {
      writeConfig({});
      invalidateConfigCache();

      const result = await run(
        { setting: "tts_provider", value: id },
        makeContext(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("tts_provider must be one of");
    }
  });

  test("error message lists all catalog provider IDs", async () => {
    const catalogIds = listCatalogProviderIds();
    const result = await run(
      { setting: "tts_provider", value: "bogus" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    for (const id of catalogIds) {
      expect(result.content).toContain(id);
    }
  });
});

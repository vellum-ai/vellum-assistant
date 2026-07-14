import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as actualManagedSpeech from "../platform/managed-speech.js";

let mockManagedSpeechAvailable = false;

mock.module("../platform/managed-speech.js", () => ({
  ...actualManagedSpeech,
  managedSpeechAvailable: async () => mockManagedSpeechAvailable,
}));

import { getConfig, invalidateConfigCache } from "../config/loader.js";
import { maybeDefaultSpeechToManaged } from "../config/managed-speech-defaults.js";

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function ensureTestDir(): void {
  if (!existsSync(WORKSPACE_DIR)) {
    mkdirSync(WORKSPACE_DIR, { recursive: true });
  }
}

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj));
  invalidateConfigCache();
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

beforeEach(() => {
  ensureTestDir();
  writeConfig({});
  mockManagedSpeechAvailable = false;
});

describe("maybeDefaultSpeechToManaged", () => {
  test("logged out: no-op — the schema's BYOK default stands", async () => {
    await maybeDefaultSpeechToManaged();

    const config = readConfig();
    expect(config.services).toBeUndefined();
  });

  test("logged in: defaults both services to managed", async () => {
    mockManagedSpeechAvailable = true;

    await maybeDefaultSpeechToManaged();

    const config = readConfig();
    expect((config.services as any)?.stt?.mode).toBe("managed");
    expect((config.services as any)?.tts?.mode).toBe("managed");
    // Sparse configs must stay schema-valid: SttServiceSchema requires
    // `provider` whenever the stt object exists.
    expect((config.services as any)?.stt?.provider).toBeDefined();
    expect(getConfig().services.stt.mode).toBe("managed");
  });

  test("logged in with BYOK providers configured but no explicit mode: still defaults to managed", async () => {
    // Connection state drives the default — a stored provider key without
    // an explicit mode choice does not pin BYOK.
    mockManagedSpeechAvailable = true;
    writeConfig({
      services: {
        stt: { provider: "deepgram" },
        tts: { provider: "elevenlabs" },
      },
    });

    await maybeDefaultSpeechToManaged();

    const config = readConfig();
    expect((config.services as any).stt.mode).toBe("managed");
    expect((config.services as any).tts.mode).toBe("managed");
    // The BYOK provider choice is preserved for a later switch back.
    expect((config.services as any).stt.provider).toBe("deepgram");
    expect((config.services as any).tts.provider).toBe("elevenlabs");
  });

  test("explicit your-own modes always win over the logged-in default", async () => {
    mockManagedSpeechAvailable = true;
    writeConfig({
      services: {
        stt: { mode: "your-own", provider: "deepgram" },
        tts: { mode: "your-own", provider: "elevenlabs" },
      },
    });

    await maybeDefaultSpeechToManaged();

    const config = readConfig();
    expect((config.services as any).stt.mode).toBe("your-own");
    expect((config.services as any).tts.mode).toBe("your-own");
  });

  test("one explicit mode: only the unset service is defaulted", async () => {
    mockManagedSpeechAvailable = true;
    writeConfig({
      services: { stt: { mode: "your-own", provider: "deepgram" } },
    });

    await maybeDefaultSpeechToManaged();

    const config = readConfig();
    expect((config.services as any).stt.mode).toBe("your-own");
    expect((config.services as any).tts.mode).toBe("managed");
  });

  test("idempotent: a second run rewrites nothing", async () => {
    mockManagedSpeechAvailable = true;
    await maybeDefaultSpeechToManaged();
    const first = readFileSync(CONFIG_PATH, "utf8");

    await maybeDefaultSpeechToManaged();

    expect(readFileSync(CONFIG_PATH, "utf8")).toBe(first);
  });
});

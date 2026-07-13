import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as actualTtsCapability from "../calls/telephony-tts-capability.js";
import * as actualManagedSpeech from "../platform/managed-speech.js";
import * as actualResolve from "../providers/speech-to-text/resolve.js";

let mockManagedSpeechAvailable = false;
let mockSttKeyResolves = false;
let mockTtsSecretResolves = false;

mock.module("../platform/managed-speech.js", () => ({
  ...actualManagedSpeech,
  managedSpeechAvailable: async () => mockManagedSpeechAvailable,
}));

mock.module("../providers/speech-to-text/resolve.js", () => ({
  ...actualResolve,
  sttProviderKeyResolves: async () => mockSttKeyResolves,
}));

mock.module("../calls/telephony-tts-capability.js", () => ({
  ...actualTtsCapability,
  ttsSecretResolves: async () => mockTtsSecretResolves,
}));

import { invalidateConfigCache } from "../config/loader.js";
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
  mockSttKeyResolves = false;
  mockTtsSecretResolves = false;
});

describe("maybeDefaultSpeechToManaged", () => {
  test("no-ops when managed speech is unavailable", async () => {
    await maybeDefaultSpeechToManaged();

    const config = readConfig();
    expect(config.services).toBeUndefined();
  });

  test("defaults both services to managed when no BYOK credentials resolve", async () => {
    mockManagedSpeechAvailable = true;

    await maybeDefaultSpeechToManaged();

    const config = readConfig();
    expect((config.services as any)?.stt?.mode).toBe("managed");
    expect((config.services as any)?.tts?.mode).toBe("managed");
  });

  test("leaves a service alone when its BYOK credential resolves", async () => {
    mockManagedSpeechAvailable = true;
    mockSttKeyResolves = true;

    await maybeDefaultSpeechToManaged();

    const config = readConfig();
    expect((config.services as any)?.stt?.mode).toBeUndefined();
    expect((config.services as any)?.tts?.mode).toBe("managed");
  });

  test("no-ops when both BYOK credentials resolve", async () => {
    mockManagedSpeechAvailable = true;
    mockSttKeyResolves = true;
    mockTtsSecretResolves = true;

    await maybeDefaultSpeechToManaged();

    const config = readConfig();
    expect(config.services).toBeUndefined();
  });

  test("no-ops when services are already managed", async () => {
    mockManagedSpeechAvailable = true;
    writeConfig({
      services: { stt: { mode: "managed" }, tts: { mode: "managed" } },
    });

    await maybeDefaultSpeechToManaged();

    const config = readConfig();
    expect(config).toEqual({
      services: { stt: { mode: "managed" }, tts: { mode: "managed" } },
    });
  });

  test("never downgrades an explicit your-own mode with resolving credentials", async () => {
    mockManagedSpeechAvailable = true;
    mockSttKeyResolves = true;
    mockTtsSecretResolves = true;
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
});

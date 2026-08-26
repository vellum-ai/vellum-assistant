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

import { getConfig, invalidateConfigCache } from "../config/loader.js";
import {
  maybeDefaultSpeechToManaged,
  resolveEffectiveSpeechProviders,
} from "../config/managed-speech-defaults.js";
import { sttCatalogKeyForRole } from "../stt/roles.js";

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

  test("defaults both services to vellum when no BYOK credentials resolve", async () => {
    mockManagedSpeechAvailable = true;

    await maybeDefaultSpeechToManaged();

    const config = readConfig();
    expect((config.services as any)?.stt?.provider).toBe("vellum");
    expect((config.services as any)?.tts?.provider).toBe("vellum");
    expect(getConfig().services.stt.provider).toBe("vellum");
  });

  test("leaves a service alone when its BYOK credential resolves", async () => {
    mockManagedSpeechAvailable = true;
    mockSttKeyResolves = true;

    await maybeDefaultSpeechToManaged();

    const config = readConfig();
    expect((config.services as any)?.stt?.provider).toBeUndefined();
    expect((config.services as any)?.tts?.provider).toBe("vellum");
  });

  test("no-ops when both BYOK credentials resolve", async () => {
    mockManagedSpeechAvailable = true;
    mockSttKeyResolves = true;
    mockTtsSecretResolves = true;

    await maybeDefaultSpeechToManaged();

    const config = readConfig();
    expect(config.services).toBeUndefined();
  });

  test("no-ops when services are already on vellum", async () => {
    mockManagedSpeechAvailable = true;
    writeConfig({
      services: {
        stt: { provider: "vellum" },
        tts: { provider: "vellum" },
      },
    });

    await maybeDefaultSpeechToManaged();

    const config = readConfig();
    expect(config).toEqual({
      services: {
        stt: { provider: "vellum" },
        tts: { provider: "vellum" },
      },
    });
  });

  test("a narrowing stand-in is written to the live-voice role, not the global", async () => {
    // BYOK Flux with no key: the stand-in preserves turn detection, so it is
    // vellum-flux, which streams and nothing else. Writing that globally is
    // how batch transcription and telephony disappear for a managed user.
    mockManagedSpeechAvailable = true;
    writeConfig({
      services: {
        stt: {
          provider: "deepgram",
          providers: { deepgram: { model: "flux" } },
        },
        tts: { provider: "vellum" },
      },
    });

    await maybeDefaultSpeechToManaged();

    const stt = (readConfig().services as any).stt;
    expect(stt.roles.liveVoice).toEqual({ provider: "vellum", model: "flux" });
    // The other consumers land on the stand-in's base, which serves them all.
    expect(stt.provider).toBe("vellum");
    expect(stt.providers.vellum.model).toBe("nova-3");
  });

  test("the role write leaves batch and telephony on a provider that answers", async () => {
    mockManagedSpeechAvailable = true;
    writeConfig({
      services: {
        stt: {
          provider: "deepgram",
          providers: { deepgram: { model: "flux" } },
        },
        tts: { provider: "vellum" },
      },
    });

    await maybeDefaultSpeechToManaged();

    invalidateConfigCache();
    const stt = getConfig().services.stt;
    expect(sttCatalogKeyForRole(stt, "liveVoice")).toBe("vellum-flux");
    expect(sttCatalogKeyForRole(stt, "batch")).toBe("vellum");
    expect(sttCatalogKeyForRole(stt, "telephony")).toBe("vellum");
  });

  test("a language Flux has no model for keeps live voice on nova-3", async () => {
    // Korean is outside Flux's ten-language roster, so the relay would reject
    // the dial. Standing in with Flux hands the speaker a dead mic rather
    // than a worse transcriber.
    mockManagedSpeechAvailable = true;
    writeConfig({
      services: {
        stt: {
          provider: "deepgram",
          language: "ko",
          providers: { deepgram: { model: "flux" } },
        },
        tts: { provider: "vellum" },
      },
    });

    await maybeDefaultSpeechToManaged();

    const stt = (readConfig().services as any).stt;
    expect(stt.provider).toBe("vellum");
    expect(stt.providers.vellum.model).toBe("nova-3");
    expect(stt.roles).toBeUndefined();
  });

  test("a language Flux does serve still reaches the flux stand-in", async () => {
    mockManagedSpeechAvailable = true;
    writeConfig({
      services: {
        stt: {
          provider: "deepgram",
          language: "hi",
          providers: { deepgram: { model: "flux" } },
        },
        tts: { provider: "vellum" },
      },
    });

    await maybeDefaultSpeechToManaged();

    const stt = (readConfig().services as any).stt;
    expect(stt.roles.liveVoice).toEqual({ provider: "vellum", model: "flux" });
  });

  test("a capability-preserving stand-in still writes the global provider", async () => {
    // Plain deepgram has no turn detection, so the stand-in is plain vellum,
    // which serves every role. That one belongs on the global, not a role.
    mockManagedSpeechAvailable = true;
    writeConfig({
      services: {
        stt: { provider: "deepgram" },
        tts: { provider: "vellum" },
      },
    });

    await maybeDefaultSpeechToManaged();

    const stt = (readConfig().services as any).stt;
    expect(stt.provider).toBe("vellum");
    expect(stt.roles).toBeUndefined();
  });

  test("never repoints an explicit BYOK provider with resolving credentials", async () => {
    mockManagedSpeechAvailable = true;
    mockSttKeyResolves = true;
    mockTtsSecretResolves = true;
    writeConfig({
      services: {
        stt: { provider: "deepgram" },
        tts: { provider: "elevenlabs" },
      },
    });

    await maybeDefaultSpeechToManaged();

    const config = readConfig();
    expect((config.services as any).stt.provider).toBe("deepgram");
    expect((config.services as any).tts.provider).toBe("elevenlabs");
  });
});

describe("managed live voice runs Flux", () => {
  // Turn detection is the only reason to reach for that family, and a managed
  // user cannot ask for it: the provider picker offers no family, so `vellum`
  // is as specific as they can be.
  test("live voice upgrades to the flux family", async () => {
    mockManagedSpeechAvailable = true;
    writeConfig({ services: { stt: { provider: "vellum" } } });

    const { stt } = await resolveEffectiveSpeechProviders(undefined, {
      role: "liveVoice",
    });

    expect(stt).toBe("vellum-flux");
  });

  test("no other consumer follows it there", async () => {
    // The family streams and nothing else, so batch and telephony would lose
    // their transcriber entirely.
    mockManagedSpeechAvailable = true;
    writeConfig({ services: { stt: { provider: "vellum" } } });

    for (const role of ["batch", "telephony", "dictation", "watch"] as const) {
      const { stt } = await resolveEffectiveSpeechProviders(undefined, {
        role,
      });
      expect(stt).toBe("vellum");
    }
    const { stt: roleless } = await resolveEffectiveSpeechProviders();
    expect(roleless).toBe("vellum");
  });

  test("a family the user named wins", async () => {
    // `services.stt.providers.vellum.model` accepts nova-3, so quietly
    // overriding it would be the silent substitution roles exist to prevent.
    mockManagedSpeechAvailable = true;
    writeConfig({
      services: {
        stt: { provider: "vellum", providers: { vellum: { model: "nova-3" } } },
      },
    });

    const { stt } = await resolveEffectiveSpeechProviders(undefined, {
      role: "liveVoice",
    });

    expect(stt).toBe("vellum");
  });

  test("a language the family cannot serve stays on nova-3", async () => {
    mockManagedSpeechAvailable = true;
    writeConfig({
      services: { stt: { provider: "vellum", language: "ko" } },
    });

    const { stt } = await resolveEffectiveSpeechProviders(undefined, {
      role: "liveVoice",
    });

    expect(stt).toBe("vellum");
  });

  test("nothing is upgraded while managed speech is unavailable", async () => {
    mockManagedSpeechAvailable = false;
    writeConfig({ services: { stt: { provider: "vellum" } } });

    const { stt } = await resolveEffectiveSpeechProviders(undefined, {
      role: "liveVoice",
    });

    expect(stt).toBe("vellum");
  });

  test("the upgrade writes no config", async () => {
    // A resolution rule, not a substitution: nothing lands on disk for a user
    // to discover, reset, or have to migrate.
    mockManagedSpeechAvailable = true;
    writeConfig({ services: { stt: { provider: "vellum" } } });
    const before = JSON.stringify(readConfig());

    await resolveEffectiveSpeechProviders(undefined, { role: "liveVoice" });

    expect(JSON.stringify(readConfig())).toBe(before);
  });
});

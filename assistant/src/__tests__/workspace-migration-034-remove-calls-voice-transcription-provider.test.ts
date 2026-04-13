import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { removeCallsVoiceTranscriptionProviderMigration } from "../workspace/migrations/034-remove-calls-voice-transcription-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-034-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("034-remove-calls-voice-transcription-provider migration", () => {
  test("has correct migration id", () => {
    expect(removeCallsVoiceTranscriptionProviderMigration.id).toBe(
      "034-remove-calls-voice-transcription-provider",
    );
  });

  // ── Google provider preference preservation ─────────────────────────────

  test("copies Google transcriptionProvider to services.stt.provider", () => {
    writeConfig({
      calls: { voice: { transcriptionProvider: "Google", language: "en-US" } },
      services: {
        stt: {
          mode: "your-own",
          provider: "deepgram",
          providers: {},
        },
      },
    });

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    const config = readConfig();
    const stt = (config.services as Record<string, unknown>).stt as Record<
      string,
      unknown
    >;
    expect(stt.provider).toBe("google-gemini");

    // Legacy key removed
    const voice = (config.calls as Record<string, unknown>).voice as Record<
      string,
      unknown
    >;
    expect(voice.transcriptionProvider).toBeUndefined();
    // Other voice fields preserved
    expect(voice.language).toBe("en-US");
  });

  test("does not overwrite deepgram when services.stt has customized provider-specific config", () => {
    // User had Google legacy provider but then explicitly configured deepgram
    // with provider-specific settings — the extra keys in services.stt signal
    // intentional customization beyond the 033 backfill.
    writeConfig({
      calls: { voice: { transcriptionProvider: "Google" } },
      services: {
        stt: {
          mode: "your-own",
          provider: "deepgram",
          providers: {},
          model: "nova-3",
        },
      },
    });

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    const config = readConfig();
    const stt = (config.services as Record<string, unknown>).stt as Record<
      string,
      unknown
    >;
    // Extra keys mean intentional customization — provider left as-is
    expect(stt.provider).toBe("deepgram");
    expect(stt.model).toBe("nova-3");
  });

  test("does not overwrite deepgram when services.stt.providers has entries", () => {
    // User explicitly added per-provider config entries, signaling they
    // customized beyond the 033 default even though the top-level keys match.
    writeConfig({
      calls: { voice: { transcriptionProvider: "Google" } },
      services: {
        stt: {
          mode: "your-own",
          provider: "deepgram",
          providers: { deepgram: { model: "nova-3" } },
        },
      },
    });

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    const config = readConfig();
    const stt = (config.services as Record<string, unknown>).stt as Record<
      string,
      unknown
    >;
    expect(stt.provider).toBe("deepgram");
  });

  test("does not overwrite deepgram when services.stt.mode differs from 033 default", () => {
    writeConfig({
      calls: { voice: { transcriptionProvider: "Google" } },
      services: {
        stt: {
          mode: "managed",
          provider: "deepgram",
          providers: {},
        },
      },
    });

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    const config = readConfig();
    const stt = (config.services as Record<string, unknown>).stt as Record<
      string,
      unknown
    >;
    expect(stt.provider).toBe("deepgram");
  });

  test("does not overwrite services.stt.provider if it is not the migration 033 default", () => {
    writeConfig({
      calls: { voice: { transcriptionProvider: "Google" } },
      services: {
        stt: {
          mode: "your-own",
          provider: "openai-whisper",
          providers: {},
        },
      },
    });

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    const config = readConfig();
    const stt = (config.services as Record<string, unknown>).stt as Record<
      string,
      unknown
    >;
    // User had explicitly set openai-whisper — should not be clobbered
    expect(stt.provider).toBe("openai-whisper");
  });

  test("does not overwrite services.stt.provider if already google-gemini", () => {
    writeConfig({
      calls: { voice: { transcriptionProvider: "Google" } },
      services: {
        stt: {
          mode: "your-own",
          provider: "google-gemini",
          providers: {},
        },
      },
    });

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    const config = readConfig();
    const stt = (config.services as Record<string, unknown>).stt as Record<
      string,
      unknown
    >;
    expect(stt.provider).toBe("google-gemini");
  });

  // ── Deepgram provider — no change needed ────────────────────────────────

  test("leaves services.stt.provider as deepgram when transcriptionProvider is Deepgram", () => {
    writeConfig({
      calls: { voice: { transcriptionProvider: "Deepgram" } },
      services: {
        stt: {
          mode: "your-own",
          provider: "deepgram",
          providers: {},
        },
      },
    });

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    const config = readConfig();
    const stt = (config.services as Record<string, unknown>).stt as Record<
      string,
      unknown
    >;
    expect(stt.provider).toBe("deepgram");

    // Legacy key removed
    const voice = (config.calls as Record<string, unknown>).voice as Record<
      string,
      unknown
    >;
    expect(voice.transcriptionProvider).toBeUndefined();
  });

  // ── Missing transcriptionProvider — no change needed ────────────────────

  test("no provider copy when transcriptionProvider is missing", () => {
    writeConfig({
      calls: { voice: { language: "en-US" } },
      services: {
        stt: {
          mode: "your-own",
          provider: "deepgram",
          providers: {},
        },
      },
    });

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    const config = readConfig();
    const stt = (config.services as Record<string, unknown>).stt as Record<
      string,
      unknown
    >;
    expect(stt.provider).toBe("deepgram");
  });

  // ── speechModel removal ─────────────────────────────────────────────────

  test("removes calls.voice.speechModel along with transcriptionProvider", () => {
    writeConfig({
      calls: {
        voice: {
          transcriptionProvider: "Deepgram",
          speechModel: "nova-2-phonecall",
          language: "en-US",
        },
      },
      services: {
        stt: { mode: "your-own", provider: "deepgram", providers: {} },
      },
    });

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    const config = readConfig();
    const voice = (config.calls as Record<string, unknown>).voice as Record<
      string,
      unknown
    >;
    expect(voice.transcriptionProvider).toBeUndefined();
    expect(voice.speechModel).toBeUndefined();
    expect(voice.language).toBe("en-US");
  });

  // ── Malformed config safety ─────────────────────────────────────────────

  test("no-op when config.json does not exist", () => {
    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("no-op when config.json contains invalid JSON", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("no-op when config.json contains a JSON array", () => {
    writeFileSync(join(workspaceDir, "config.json"), JSON.stringify([1, 2, 3]));

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    const raw = JSON.parse(
      readFileSync(join(workspaceDir, "config.json"), "utf-8"),
    );
    expect(raw).toEqual([1, 2, 3]);
  });

  test("no-op when calls block is missing", () => {
    writeConfig({ maxTokens: 64000 });

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    const config = readConfig();
    expect(config.maxTokens).toBe(64000);
    expect(config.calls).toBeUndefined();
  });

  test("no-op when calls.voice is missing", () => {
    writeConfig({ calls: { enabled: true } });

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    const config = readConfig();
    const calls = config.calls as Record<string, unknown>;
    expect(calls.enabled).toBe(true);
    expect(calls.voice).toBeUndefined();
  });

  test("no-op when calls is a non-object value", () => {
    writeConfig({ calls: "invalid" });

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    const config = readConfig();
    expect(config.calls).toBe("invalid");
  });

  test("no-op when calls.voice is a non-object value", () => {
    writeConfig({ calls: { voice: 42 } });

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    const config = readConfig();
    const calls = config.calls as Record<string, unknown>;
    expect(calls.voice).toBe(42);
  });

  test("no-op when services.stt is missing (no crash)", () => {
    writeConfig({
      calls: { voice: { transcriptionProvider: "Google" } },
    });

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    const config = readConfig();
    // Legacy key still removed even without services.stt
    const voice = (config.calls as Record<string, unknown>).voice as Record<
      string,
      unknown
    >;
    expect(voice.transcriptionProvider).toBeUndefined();
    // services was never created since there was no stt to update
    expect(config.services).toBeUndefined();
  });

  test("no-op when services is a non-object value", () => {
    writeConfig({
      calls: { voice: { transcriptionProvider: "Google" } },
      services: "invalid",
    });

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    const config = readConfig();
    // Legacy key removed
    const voice = (config.calls as Record<string, unknown>).voice as Record<
      string,
      unknown
    >;
    expect(voice.transcriptionProvider).toBeUndefined();
    // services not modified (can't read stt from a string)
    expect(config.services).toBe("invalid");
  });

  test("no-op when services.stt is a non-object value", () => {
    writeConfig({
      calls: { voice: { transcriptionProvider: "Google" } },
      services: { stt: "invalid" },
    });

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    const config = readConfig();
    const voice = (config.calls as Record<string, unknown>).voice as Record<
      string,
      unknown
    >;
    expect(voice.transcriptionProvider).toBeUndefined();
    // services.stt left as-is since it's not an object
    const services = config.services as Record<string, unknown>;
    expect(services.stt).toBe("invalid");
  });

  // ── Idempotency ─────────────────────────────────────────────────────────

  test("second run produces identical output (Google preference preserved)", () => {
    writeConfig({
      calls: { voice: { transcriptionProvider: "Google" } },
      services: {
        stt: { mode: "your-own", provider: "deepgram", providers: {} },
      },
    });

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);
    const afterFirst = readConfig();

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);
    const afterSecond = readConfig();

    expect(afterSecond).toEqual(afterFirst);
  });

  test("second run produces identical output (Deepgram, no provider change)", () => {
    writeConfig({
      calls: { voice: { transcriptionProvider: "Deepgram" } },
      services: {
        stt: { mode: "your-own", provider: "deepgram", providers: {} },
      },
    });

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);
    const afterFirst = readConfig();

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);
    const afterSecond = readConfig();

    expect(afterSecond).toEqual(afterFirst);
  });

  test("does not write file when nothing to change (already migrated)", () => {
    const original = {
      calls: { voice: { language: "en-US", hints: [] } },
      services: {
        stt: { mode: "your-own", provider: "google-gemini", providers: {} },
      },
    };
    writeConfig(original);

    const before = readFileSync(join(workspaceDir, "config.json"), "utf-8");

    removeCallsVoiceTranscriptionProviderMigration.run(workspaceDir);

    const after = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    expect(after).toBe(before);
  });

  // ── down() ───────────────────────────────────────────────────────────────

  describe("down()", () => {
    test("restores Deepgram as calls.voice.transcriptionProvider", () => {
      writeConfig({
        calls: { voice: { language: "en-US" } },
        services: {
          stt: { mode: "your-own", provider: "deepgram", providers: {} },
        },
      });

      removeCallsVoiceTranscriptionProviderMigration.down(workspaceDir);

      const config = readConfig();
      const voice = (config.calls as Record<string, unknown>).voice as Record<
        string,
        unknown
      >;
      expect(voice.transcriptionProvider).toBe("Deepgram");
    });

    test("restores Google as calls.voice.transcriptionProvider from google-gemini", () => {
      writeConfig({
        calls: { voice: { language: "en-US" } },
        services: {
          stt: { mode: "your-own", provider: "google-gemini", providers: {} },
        },
      });

      removeCallsVoiceTranscriptionProviderMigration.down(workspaceDir);

      const config = readConfig();
      const voice = (config.calls as Record<string, unknown>).voice as Record<
        string,
        unknown
      >;
      expect(voice.transcriptionProvider).toBe("Google");
    });

    test("does not overwrite existing transcriptionProvider", () => {
      writeConfig({
        calls: { voice: { transcriptionProvider: "Deepgram" } },
        services: {
          stt: { mode: "your-own", provider: "google-gemini", providers: {} },
        },
      });

      removeCallsVoiceTranscriptionProviderMigration.down(workspaceDir);

      const config = readConfig();
      const voice = (config.calls as Record<string, unknown>).voice as Record<
        string,
        unknown
      >;
      // Existing value preserved, not overwritten
      expect(voice.transcriptionProvider).toBe("Deepgram");
    });

    test("no-op when config.json does not exist", () => {
      removeCallsVoiceTranscriptionProviderMigration.down(workspaceDir);
      // Should not throw
    });

    test("no-op when config has no services.stt", () => {
      writeConfig({ maxTokens: 64000 });

      removeCallsVoiceTranscriptionProviderMigration.down(workspaceDir);

      const config = readConfig();
      expect(config.maxTokens).toBe(64000);
    });

    test("no-op for unknown provider (openai-whisper)", () => {
      writeConfig({
        calls: { voice: { language: "en-US" } },
        services: {
          stt: { mode: "your-own", provider: "openai-whisper", providers: {} },
        },
      });

      removeCallsVoiceTranscriptionProviderMigration.down(workspaceDir);

      const config = readConfig();
      const voice = (config.calls as Record<string, unknown>).voice as Record<
        string,
        unknown
      >;
      // No legacy equivalent for openai-whisper — field not added
      expect(voice.transcriptionProvider).toBeUndefined();
    });

    test("idempotent: calling down() twice is safe", () => {
      writeConfig({
        calls: { voice: { language: "en-US" } },
        services: {
          stt: { mode: "your-own", provider: "deepgram", providers: {} },
        },
      });

      removeCallsVoiceTranscriptionProviderMigration.down(workspaceDir);
      removeCallsVoiceTranscriptionProviderMigration.down(workspaceDir);

      const config = readConfig();
      const voice = (config.calls as Record<string, unknown>).voice as Record<
        string,
        unknown
      >;
      expect(voice.transcriptionProvider).toBe("Deepgram");
    });

    test("gracefully handles malformed JSON", () => {
      writeFileSync(join(workspaceDir, "config.json"), "bad-json");

      removeCallsVoiceTranscriptionProviderMigration.down(workspaceDir);

      expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
        "bad-json",
      );
    });
  });
});

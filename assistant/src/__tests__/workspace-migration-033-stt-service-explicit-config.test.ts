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

import { sttServiceExplicitConfigMigration } from "../workspace/migrations/033-stt-service-explicit-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-033-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("033-stt-service-explicit-config migration", () => {
  test("has correct migration id", () => {
    expect(sttServiceExplicitConfigMigration.id).toBe(
      "033-stt-service-explicit-config",
    );
  });

  // ─── Fresh config backfill ─────────────────────────────────────────────

  test("backfills full services.stt block on config with no services key", () => {
    writeConfig({ maxTokens: 64000 });

    sttServiceExplicitConfigMigration.run(workspaceDir);

    const config = readConfig();
    const services = config.services as Record<string, unknown>;
    const stt = services.stt as Record<string, unknown>;

    expect(stt.mode).toBe("your-own");
    expect(stt.provider).toBe("openai-whisper");
    expect(stt.providers).toEqual({
      "openai-whisper": {},
      deepgram: {},
    });

    // Other config keys preserved
    expect(config.maxTokens).toBe(64000);
  });

  test("backfills services.stt when services exists but has no stt key", () => {
    writeConfig({
      services: {
        inference: { mode: "your-own", provider: "anthropic" },
      },
    });

    sttServiceExplicitConfigMigration.run(workspaceDir);

    const config = readConfig();
    const services = config.services as Record<string, unknown>;
    const stt = services.stt as Record<string, unknown>;

    expect(stt.mode).toBe("your-own");
    expect(stt.provider).toBe("openai-whisper");
    expect(stt.providers).toEqual({
      "openai-whisper": {},
      deepgram: {},
    });

    // Existing services preserved
    const inference = services.inference as Record<string, unknown>;
    expect(inference.provider).toBe("anthropic");
  });

  test("backfills on empty config object", () => {
    writeConfig({});

    sttServiceExplicitConfigMigration.run(workspaceDir);

    const config = readConfig();
    const services = config.services as Record<string, unknown>;
    const stt = services.stt as Record<string, unknown>;

    expect(stt.mode).toBe("your-own");
    expect(stt.provider).toBe("openai-whisper");
    expect(stt.providers).toEqual({
      "openai-whisper": {},
      deepgram: {},
    });
  });

  // ─── Partial STT object completion ────────────────────────────────────

  test("fills in missing mode when stt has provider and providers", () => {
    writeConfig({
      services: {
        stt: {
          provider: "deepgram",
          providers: { "openai-whisper": {}, deepgram: {} },
        },
      },
    });

    sttServiceExplicitConfigMigration.run(workspaceDir);

    const config = readConfig();
    const stt = (config.services as Record<string, unknown>).stt as Record<
      string,
      unknown
    >;

    expect(stt.mode).toBe("your-own");
    expect(stt.provider).toBe("deepgram");
  });

  test("fills in missing provider when stt has mode and providers", () => {
    writeConfig({
      services: {
        stt: {
          mode: "your-own",
          providers: { "openai-whisper": {}, deepgram: {} },
        },
      },
    });

    sttServiceExplicitConfigMigration.run(workspaceDir);

    const config = readConfig();
    const stt = (config.services as Record<string, unknown>).stt as Record<
      string,
      unknown
    >;

    expect(stt.provider).toBe("openai-whisper");
    expect(stt.mode).toBe("your-own");
  });

  test("fills in missing providers entries when stt has mode and provider", () => {
    writeConfig({
      services: {
        stt: {
          mode: "your-own",
          provider: "deepgram",
        },
      },
    });

    sttServiceExplicitConfigMigration.run(workspaceDir);

    const config = readConfig();
    const stt = (config.services as Record<string, unknown>).stt as Record<
      string,
      unknown
    >;
    const providers = stt.providers as Record<string, unknown>;

    expect(providers["openai-whisper"]).toEqual({});
    expect(providers.deepgram).toEqual({});
  });

  test("fills in missing deepgram entry when only openai-whisper exists in providers", () => {
    writeConfig({
      services: {
        stt: {
          mode: "your-own",
          provider: "openai-whisper",
          providers: { "openai-whisper": {} },
        },
      },
    });

    sttServiceExplicitConfigMigration.run(workspaceDir);

    const config = readConfig();
    const stt = (config.services as Record<string, unknown>).stt as Record<
      string,
      unknown
    >;
    const providers = stt.providers as Record<string, unknown>;

    expect(providers["openai-whisper"]).toEqual({});
    expect(providers.deepgram).toEqual({});
  });

  // ─── Preservation of explicit user provider overrides ─────────────────

  test("preserves explicit user-defined provider value", () => {
    writeConfig({
      services: {
        stt: {
          mode: "your-own",
          provider: "deepgram",
          providers: { "openai-whisper": {}, deepgram: {} },
        },
      },
    });

    sttServiceExplicitConfigMigration.run(workspaceDir);

    const config = readConfig();
    const stt = (config.services as Record<string, unknown>).stt as Record<
      string,
      unknown
    >;

    expect(stt.provider).toBe("deepgram");
  });

  test("preserves existing provider-specific config values", () => {
    writeConfig({
      services: {
        stt: {
          mode: "your-own",
          provider: "deepgram",
          providers: {
            "openai-whisper": { customSetting: "preserved" },
            deepgram: { model: "nova-3" },
          },
        },
      },
    });

    sttServiceExplicitConfigMigration.run(workspaceDir);

    const config = readConfig();
    const stt = (config.services as Record<string, unknown>).stt as Record<
      string,
      unknown
    >;
    const providers = stt.providers as Record<string, unknown>;
    const whisper = providers["openai-whisper"] as Record<string, unknown>;
    const deepgram = providers.deepgram as Record<string, unknown>;

    expect(whisper.customSetting).toBe("preserved");
    expect(deepgram.model).toBe("nova-3");
  });

  test("does not clobber explicit mode value", () => {
    writeConfig({
      services: {
        stt: {
          mode: "your-own",
        },
      },
    });

    sttServiceExplicitConfigMigration.run(workspaceDir);

    const config = readConfig();
    const stt = (config.services as Record<string, unknown>).stt as Record<
      string,
      unknown
    >;
    expect(stt.mode).toBe("your-own");
  });

  test("preserves other services keys", () => {
    writeConfig({
      services: {
        inference: { mode: "your-own", provider: "anthropic" },
        tts: { mode: "your-own", provider: "elevenlabs" },
      },
    });

    sttServiceExplicitConfigMigration.run(workspaceDir);

    const config = readConfig();
    const services = config.services as Record<string, Record<string, unknown>>;

    expect(services.inference.provider).toBe("anthropic");
    expect(services.tts.provider).toBe("elevenlabs");
    expect(services.stt).toBeDefined();
  });

  // ─── Malformed config no-op ───────────────────────────────────────────

  test("no-op when config.json does not exist", () => {
    sttServiceExplicitConfigMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("no-op when config.json contains invalid JSON", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");

    sttServiceExplicitConfigMigration.run(workspaceDir);

    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("no-op when config.json contains a JSON array", () => {
    writeFileSync(join(workspaceDir, "config.json"), JSON.stringify([1, 2, 3]));

    sttServiceExplicitConfigMigration.run(workspaceDir);

    const raw = JSON.parse(
      readFileSync(join(workspaceDir, "config.json"), "utf-8"),
    );
    expect(raw).toEqual([1, 2, 3]);
  });

  test("no-op when config.json contains a JSON string", () => {
    writeFileSync(
      join(workspaceDir, "config.json"),
      JSON.stringify("just a string"),
    );

    sttServiceExplicitConfigMigration.run(workspaceDir);

    const raw = JSON.parse(
      readFileSync(join(workspaceDir, "config.json"), "utf-8"),
    );
    expect(raw).toBe("just a string");
  });

  test("recovers when services.stt is a non-object value", () => {
    writeConfig({
      services: {
        stt: "invalid",
      },
    });

    sttServiceExplicitConfigMigration.run(workspaceDir);

    const config = readConfig();
    const stt = (config.services as Record<string, unknown>).stt as Record<
      string,
      unknown
    >;

    // ensureObj replaces the non-object with a fresh object and backfills
    expect(stt.mode).toBe("your-own");
    expect(stt.provider).toBe("openai-whisper");
  });

  test("recovers when services is a non-object value", () => {
    writeConfig({
      services: 42,
    });

    sttServiceExplicitConfigMigration.run(workspaceDir);

    const config = readConfig();
    const services = config.services as Record<string, unknown>;
    const stt = services.stt as Record<string, unknown>;

    expect(stt.mode).toBe("your-own");
    expect(stt.provider).toBe("openai-whisper");
  });

  // ─── Second-run idempotency ───────────────────────────────────────────

  test("second run produces identical output (fresh backfill)", () => {
    writeConfig({ maxTokens: 64000 });

    sttServiceExplicitConfigMigration.run(workspaceDir);
    const afterFirst = readConfig();

    sttServiceExplicitConfigMigration.run(workspaceDir);
    const afterSecond = readConfig();

    expect(afterSecond).toEqual(afterFirst);
  });

  test("second run produces identical output (already complete config)", () => {
    writeConfig({
      services: {
        stt: {
          mode: "your-own",
          provider: "deepgram",
          providers: {
            "openai-whisper": {},
            deepgram: { model: "nova-3" },
          },
        },
      },
    });

    sttServiceExplicitConfigMigration.run(workspaceDir);
    const afterFirst = readConfig();

    sttServiceExplicitConfigMigration.run(workspaceDir);
    const afterSecond = readConfig();

    expect(afterSecond).toEqual(afterFirst);
  });

  test("does not write file when nothing changed (fully populated config)", () => {
    const original = {
      services: {
        stt: {
          mode: "your-own",
          provider: "openai-whisper",
          providers: {
            "openai-whisper": {},
            deepgram: {},
          },
        },
      },
    };
    writeConfig(original);

    // Capture the file's mtime before migration
    const before = readFileSync(join(workspaceDir, "config.json"), "utf-8");

    sttServiceExplicitConfigMigration.run(workspaceDir);

    const after = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    // Content should be byte-identical since nothing changed
    expect(after).toBe(before);
  });

  // ─── down() ───────────────────────────────────────────────────────────

  describe("down()", () => {
    test("removes services.stt block", () => {
      writeConfig({
        services: {
          inference: { mode: "your-own", provider: "anthropic" },
          stt: {
            mode: "your-own",
            provider: "openai-whisper",
            providers: { "openai-whisper": {}, deepgram: {} },
          },
        },
      });

      sttServiceExplicitConfigMigration.down(workspaceDir);

      const config = readConfig();
      const services = config.services as Record<string, unknown>;
      expect(services.stt).toBeUndefined();
      // Other services preserved
      expect(services.inference).toBeDefined();
    });

    test("no-op when config.json does not exist", () => {
      sttServiceExplicitConfigMigration.down(workspaceDir);
      // Should not throw
    });

    test("no-op when config has no services key", () => {
      writeConfig({ maxTokens: 64000 });

      sttServiceExplicitConfigMigration.down(workspaceDir);

      const config = readConfig();
      expect(config.maxTokens).toBe(64000);
    });

    test("no-op when services.stt does not exist", () => {
      writeConfig({
        services: {
          inference: { mode: "your-own", provider: "anthropic" },
        },
      });

      sttServiceExplicitConfigMigration.down(workspaceDir);

      const config = readConfig();
      const services = config.services as Record<string, unknown>;
      expect(services.inference).toBeDefined();
    });

    test("idempotent: calling down() twice is safe", () => {
      writeConfig({
        services: {
          stt: {
            mode: "your-own",
            provider: "openai-whisper",
            providers: { "openai-whisper": {}, deepgram: {} },
          },
        },
      });

      sttServiceExplicitConfigMigration.down(workspaceDir);
      sttServiceExplicitConfigMigration.down(workspaceDir);

      const config = readConfig();
      const services = config.services as Record<string, unknown>;
      expect(services.stt).toBeUndefined();
    });

    test("gracefully handles malformed JSON", () => {
      writeFileSync(join(workspaceDir, "config.json"), "bad-json");

      sttServiceExplicitConfigMigration.down(workspaceDir);

      expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
        "bad-json",
      );
    });
  });
});

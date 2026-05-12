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

import { dropServicesInferenceModeMigration } from "../workspace/migrations/076-drop-services-inference-mode.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-076-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("076-drop-services-inference-mode migration", () => {
  test("has correct migration id and description", () => {
    expect(dropServicesInferenceModeMigration.id).toBe(
      "076-drop-services-inference-mode",
    );
    expect(dropServicesInferenceModeMigration.description).toBe(
      "Strip services.inference.mode from config.json (mode field removed from schema)",
    );
  });

  // ─── No-op cases ────────────────────────────────────────────────────────

  test("no-op when config.json does not exist", () => {
    dropServicesInferenceModeMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("no-op when config has no services key", () => {
    const original = { llm: { default: { provider: "anthropic" } } };
    writeConfig(original);
    dropServicesInferenceModeMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("no-op when services.inference has no mode field", () => {
    const original = { services: { inference: {} } };
    writeConfig(original);
    dropServicesInferenceModeMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("gracefully handles invalid JSON", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    dropServicesInferenceModeMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("gracefully handles array-shaped config", () => {
    writeFileSync(join(workspaceDir, "config.json"), JSON.stringify([1, 2, 3]));
    dropServicesInferenceModeMigration.run(workspaceDir);
    const raw = JSON.parse(
      readFileSync(join(workspaceDir, "config.json"), "utf-8"),
    );
    expect(raw).toEqual([1, 2, 3]);
  });

  test("gracefully handles non-object services value", () => {
    writeConfig({ services: 42, other: true });
    dropServicesInferenceModeMigration.run(workspaceDir);
    expect(readConfig()).toEqual({ services: 42, other: true });
  });

  test("gracefully handles non-object services.inference value", () => {
    writeConfig({ services: { inference: "managed" } });
    dropServicesInferenceModeMigration.run(workspaceDir);
    expect(readConfig()).toEqual({ services: { inference: "managed" } });
  });

  // ─── Core strip behaviour ──────────────────────────────────────────────

  test("strips mode from services.inference when present", () => {
    writeConfig({
      services: { inference: { mode: "managed" } },
      otherKey: "preserved",
    });

    dropServicesInferenceModeMigration.run(workspaceDir);

    const config = readConfig();
    const services = config.services as { inference: Record<string, unknown> };
    expect(services.inference.mode).toBeUndefined();
    expect(config.otherKey).toBe("preserved");
  });

  test("strips mode:'your-own' just as well as mode:'managed'", () => {
    writeConfig({ services: { inference: { mode: "your-own" } } });
    dropServicesInferenceModeMigration.run(workspaceDir);
    const services = readConfig().services as {
      inference: Record<string, unknown>;
    };
    expect(services.inference.mode).toBeUndefined();
  });

  test("leaves services.inference as {} after stripping mode", () => {
    writeConfig({ services: { inference: { mode: "managed" } } });
    dropServicesInferenceModeMigration.run(workspaceDir);
    const services = readConfig().services as Record<string, unknown>;
    expect(services.inference).toEqual({});
  });

  test("leaves other services.inference keys untouched", () => {
    // Defensive: if any future migration writes extra keys, they must survive.
    writeConfig({
      services: { inference: { mode: "your-own", someOtherKey: true } },
    });
    dropServicesInferenceModeMigration.run(workspaceDir);
    const services = readConfig().services as {
      inference: Record<string, unknown>;
    };
    expect(services.inference.mode).toBeUndefined();
    expect(services.inference.someOtherKey).toBe(true);
  });

  test("leaves other services entries untouched", () => {
    writeConfig({
      services: {
        inference: { mode: "managed" },
        "image-generation": { mode: "managed", provider: "gemini" },
        "web-search": { mode: "your-own" },
      },
    });
    dropServicesInferenceModeMigration.run(workspaceDir);
    const services = readConfig().services as Record<
      string,
      Record<string, unknown>
    >;
    expect(services["inference"]!.mode).toBeUndefined();
    expect(services["image-generation"]!.mode).toBe("managed");
    expect(services["image-generation"]!.provider).toBe("gemini");
    expect(services["web-search"]!.mode).toBe("your-own");
  });

  // ─── Idempotency ───────────────────────────────────────────────────────

  test("idempotency: re-running after strip is a no-op", () => {
    writeConfig({ services: { inference: { mode: "managed" } } });

    dropServicesInferenceModeMigration.run(workspaceDir);
    const afterFirst = readConfig();

    dropServicesInferenceModeMigration.run(workspaceDir);
    const afterSecond = readConfig();

    expect(afterSecond).toEqual(afterFirst);
  });

  test("idempotency: no-op on already-stripped config (no writes)", () => {
    const original = { services: { inference: {} }, llm: {} };
    writeConfig(original);

    const beforeContent = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );
    dropServicesInferenceModeMigration.run(workspaceDir);
    const afterContent = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );

    expect(afterContent).toBe(beforeContent);
  });
});

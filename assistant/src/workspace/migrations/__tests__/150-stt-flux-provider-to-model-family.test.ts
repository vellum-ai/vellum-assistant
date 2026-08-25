import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { sttFluxProviderToModelFamilyMigration } from "../150-stt-flux-provider-to-model-family.js";
import { WORKSPACE_MIGRATIONS } from "../registry.js";

function workspaceWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "stt-flux-migration-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  return dir;
}

function readConfig(dir: string): any {
  return JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
}

describe("150-stt-flux-provider-to-model-family", () => {
  test("is registered as the newest migration", () => {
    expect(sttFluxProviderToModelFamilyMigration.id).toBe(
      "150-stt-flux-provider-to-model-family",
    );
    expect(WORKSPACE_MIGRATIONS.at(-1)?.id).toBe(
      "150-stt-flux-provider-to-model-family",
    );
  });

  test("rewrites a Flux provider id to its parent plus a model family", () => {
    const dir = workspaceWith({
      services: { stt: { provider: "deepgram-flux", providers: {} } },
    });

    sttFluxProviderToModelFamilyMigration.run(dir);

    expect(readConfig(dir).services.stt).toEqual({
      provider: "deepgram",
      providers: { deepgram: { model: "flux" } },
    });
  });

  test("rewrites the managed pair the same way", () => {
    const dir = workspaceWith({
      services: { stt: { provider: "vellum-flux", providers: {} } },
    });

    sttFluxProviderToModelFamilyMigration.run(dir);

    expect(readConfig(dir).services.stt.provider).toBe("vellum");
    expect(readConfig(dir).services.stt.providers.vellum.model).toBe("flux");
  });

  test("keeps existing settings on the parent's entry", () => {
    const dir = workspaceWith({
      services: {
        stt: {
          provider: "deepgram-flux",
          providers: { deepgram: { someExistingKey: 1 } },
        },
      },
    });

    sttFluxProviderToModelFamilyMigration.run(dir);

    expect(readConfig(dir).services.stt.providers.deepgram).toEqual({
      someExistingKey: 1,
      model: "flux",
    });
  });

  test("leaves a non-Flux provider untouched", () => {
    const before = {
      services: { stt: { provider: "deepgram", providers: {} } },
    };
    const dir = workspaceWith(before);

    sttFluxProviderToModelFamilyMigration.run(dir);

    expect(readConfig(dir)).toEqual(before);
  });

  test("is idempotent", () => {
    const dir = workspaceWith({
      services: { stt: { provider: "deepgram-flux", providers: {} } },
    });

    sttFluxProviderToModelFamilyMigration.run(dir);
    const once = readConfig(dir);
    sttFluxProviderToModelFamilyMigration.run(dir);

    expect(readConfig(dir)).toEqual(once);
  });

  test("does nothing without a config file, or with an unparseable one", () => {
    const empty = mkdtempSync(join(tmpdir(), "stt-flux-migration-"));
    expect(() =>
      sttFluxProviderToModelFamilyMigration.run(empty),
    ).not.toThrow();

    const broken = mkdtempSync(join(tmpdir(), "stt-flux-migration-"));
    writeFileSync(join(broken, "config.json"), "{not json");
    expect(() =>
      sttFluxProviderToModelFamilyMigration.run(broken),
    ).not.toThrow();
  });
});

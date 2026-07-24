import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  crossEnvironmentAssistantHint,
  detectOtherEnvironmentAssistants,
} from "../detect.js";
import { getSeed } from "../resolve.js";

const prod = getSeed("production")!;

/** Create `<XDG_DATA_HOME>/vellum-<env>/assistants/<id>/` for a non-prod env. */
function seedAssistantDir(dataHome: string, envName: string, id: string): void {
  mkdirSync(join(dataHome, `vellum-${envName}`, "assistants", id), {
    recursive: true,
  });
}

describe("cross-environment assistant detection", () => {
  let dataHome: string;
  let prevXdg: string | undefined;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevXdg = process.env.XDG_DATA_HOME;
    prevEnv = process.env.VELLUM_ENVIRONMENT;
    dataHome = mkdtempSync(join(tmpdir(), "cli-detect-xdg-"));
    process.env.XDG_DATA_HOME = dataHome;
    // Pin the current env so the hint's "this CLI targets '<env>'" copy and
    // the current-env skip are deterministic regardless of machine config.
    process.env.VELLUM_ENVIRONMENT = "production";
  });

  afterEach(() => {
    if (prevXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = prevXdg;
    }
    if (prevEnv === undefined) {
      delete process.env.VELLUM_ENVIRONMENT;
    } else {
      process.env.VELLUM_ENVIRONMENT = prevEnv;
    }
    rmSync(dataHome, { recursive: true, force: true });
  });

  test("finds an env whose data dir holds an assistant subdirectory", () => {
    seedAssistantDir(dataHome, "dev", "dev-bot");
    expect(detectOtherEnvironmentAssistants(prod)).toContain("dev");
  });

  test("reports every other env that holds assistants", () => {
    seedAssistantDir(dataHome, "dev", "dev-bot");
    seedAssistantDir(dataHome, "staging", "staging-bot");
    const others = detectOtherEnvironmentAssistants(prod);
    expect(others).toContain("dev");
    expect(others).toContain("staging");
  });

  test("skips the current environment even when it holds assistants", () => {
    // production's own multi-instance dir (no env suffix).
    mkdirSync(join(dataHome, "vellum", "assistants", "prod-bot"), {
      recursive: true,
    });
    expect(detectOtherEnvironmentAssistants(prod)).toEqual([]);
  });

  test("ignores an env dir that holds no assistant subdirectory", () => {
    mkdirSync(join(dataHome, "vellum-dev", "assistants"), { recursive: true });
    expect(detectOtherEnvironmentAssistants(prod)).toEqual([]);
  });

  test("returns empty when no env data dirs exist", () => {
    expect(detectOtherEnvironmentAssistants(prod)).toEqual([]);
  });

  test("swallows fs errors (data root is a file, not a dir) and returns empty", () => {
    const filePath = join(dataHome, "not-a-dir");
    writeFileSync(filePath, "x");
    process.env.XDG_DATA_HOME = filePath;
    expect(detectOtherEnvironmentAssistants(prod)).toEqual([]);
    expect(crossEnvironmentAssistantHint()).toBeNull();
  });

  test("hint names the env, the current env, and both fixes", () => {
    seedAssistantDir(dataHome, "dev", "dev-bot");
    const hint = crossEnvironmentAssistantHint();
    expect(hint).not.toBeNull();
    expect(hint).toContain("'dev'");
    expect(hint).toContain("This CLI targets 'production'");
    expect(hint).toContain("Install vellum Command");
    expect(hint).toContain("VELLUM_ENVIRONMENT=dev");
  });

  test("hint is null when no other env has assistants", () => {
    expect(crossEnvironmentAssistantHint()).toBeNull();
  });
});

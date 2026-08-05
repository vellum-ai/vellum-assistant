import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { sttEnglishDefaultToMultilingualMigration as MIG } from "../100-stt-english-default-to-multilingual.js";

let workspaceDir: string;
let configPath: string;

function write(stt: Record<string, unknown>): void {
  writeFileSync(
    configPath,
    JSON.stringify({ services: { stt } }, null, 2) + "\n",
  );
}
function language(): unknown {
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  return config.services.stt.language;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "stt-en-to-multi-"));
  mkdirSync(workspaceDir, { recursive: true });
  configPath = join(workspaceDir, "config.json");
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("100-stt-english-default-to-multilingual", () => {
  test("moves an accepted English default to multilingual on deepgram", () => {
    write({ provider: "deepgram", language: "en" });
    MIG.run(workspaceDir);
    expect(language()).toBe("multi");
  });

  test("moves it on the managed relay", () => {
    write({ provider: "vellum", language: "en" });
    MIG.run(workspaceDir);
    expect(language()).toBe("multi");
  });

  test("treats legacy managed mode as the relay, not as its restore provider", () => {
    // `mode: "managed"` routes to Vellum while `provider` holds the value a
    // switch back to bring-your-own would restore, so mode has to win.
    write({ mode: "managed", provider: "deepgram", language: "en" });
    MIG.run(workspaceDir);
    expect(language()).toBe("multi");
  });

  test("leaves a real language alone", () => {
    // Any language other than English could only have come from picking it
    // out of the list, which is a choice rather than an accepted default.
    write({ provider: "deepgram", language: "hi" });
    MIG.run(workspaceDir);
    expect(language()).toBe("hi");
  });

  test("leaves English alone under xai, where it was a real option", () => {
    // xai has offered an explicit English row since the picker shipped, so
    // "en" there is deliberate.
    write({ provider: "xai", language: "en" });
    MIG.run(workspaceDir);
    expect(language()).toBe("en");
  });

  test("leaves an assistant already on multilingual untouched", () => {
    write({ provider: "deepgram", language: "multi" });
    MIG.run(workspaceDir);
    expect(language()).toBe("multi");
  });

  test("is idempotent", () => {
    write({ provider: "deepgram", language: "en" });
    MIG.run(workspaceDir);
    MIG.run(workspaceDir);
    expect(language()).toBe("multi");
  });

  test("does nothing when no language is set", () => {
    // The schema default covers unset, so the migration has nothing to say
    // about it and must not invent a key.
    write({ provider: "deepgram" });
    MIG.run(workspaceDir);
    expect(language()).toBeUndefined();
  });

  test("survives a config with no services block", () => {
    writeFileSync(configPath, JSON.stringify({}, null, 2) + "\n");
    expect(() => MIG.run(workspaceDir)).not.toThrow();
  });

  test("survives a missing or unreadable config", () => {
    rmSync(configPath, { force: true });
    expect(() => MIG.run(workspaceDir)).not.toThrow();
    writeFileSync(configPath, "{ not json");
    expect(() => MIG.run(workspaceDir)).not.toThrow();
  });
});

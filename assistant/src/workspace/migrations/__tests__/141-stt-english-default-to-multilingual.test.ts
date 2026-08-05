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

import { sttEnglishDefaultToMultilingualMigration as MIG } from "../141-stt-english-default-to-multilingual.js";

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

describe("141-stt-english-default-to-multilingual", () => {
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

  test("fills a language that was never set", () => {
    // The config route serves the RAW config, so a schema default never
    // reaches the web. Without writing it here the settings UI would read an
    // absent language as English while live transcription used multilingual.
    write({ provider: "deepgram" });
    MIG.run(workspaceDir);
    expect(language()).toBe("multi");
  });

  test("does not fill an absent language under xai", () => {
    // Unset means native detection there, which is broader than the ten
    // languages code-switching follows.
    write({ provider: "xai" });
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

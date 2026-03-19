import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

let tempDir: string;

mock.module("../util/platform.js", () => ({
  getWorkspacePromptPath: mock((file: string) => join(tempDir, file)),
  getWorkspaceDir: () => tempDir,
  getRootDir: () => tempDir,
  getDataDir: () => join(tempDir, "data"),
  getPlatformName: () => "darwin",
  isMacOS: () => false,
  isLinux: () => false,
  isWindows: () => false,
  ensureDataDir: () => {},
  getDbPath: () => "",
  getLogPath: () => "",
  getHistoryPath: () => "",
  getHooksDir: () => "",
  getSessionTokenPath: () => "",
  getPlatformTokenPath: () => "",
  getPidPath: () => "",
}));

const { isWakeUpGreeting, getCannedFirstGreeting, CANNED_FIRST_GREETING } =
  await import("../daemon/first-greeting.js");

describe("first-greeting", () => {
  beforeEach(() => {
    tempDir = join(tmpdir(), `first-greeting-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("isWakeUpGreeting", () => {
    it("returns true for wake-up greeting with 0 messages and BOOTSTRAP.md present", () => {
      writeFileSync(join(tempDir, "BOOTSTRAP.md"), "bootstrap content");
      expect(isWakeUpGreeting("Wake up, my friend.", 0)).toBe(true);
    });

    it("returns true for case variations", () => {
      writeFileSync(join(tempDir, "BOOTSTRAP.md"), "bootstrap content");
      expect(isWakeUpGreeting("wake up, my friend.", 0)).toBe(true);
      expect(isWakeUpGreeting("WAKE UP, MY FRIEND.", 0)).toBe(true);
      expect(isWakeUpGreeting("Wake Up, My Friend.", 0)).toBe(true);
    });

    it("returns false when content doesn't match wake-up greeting", () => {
      writeFileSync(join(tempDir, "BOOTSTRAP.md"), "bootstrap content");
      expect(isWakeUpGreeting("Hello", 0)).toBe(false);
      expect(isWakeUpGreeting("Hey there", 0)).toBe(false);
      expect(isWakeUpGreeting("Wake up", 0)).toBe(false);
    });

    it("returns false when conversationMessageCount > 0", () => {
      writeFileSync(join(tempDir, "BOOTSTRAP.md"), "bootstrap content");
      expect(isWakeUpGreeting("Wake up, my friend.", 1)).toBe(false);
      expect(isWakeUpGreeting("Wake up, my friend.", 5)).toBe(false);
    });

    it("returns false when BOOTSTRAP.md doesn't exist", () => {
      expect(existsSync(join(tempDir, "BOOTSTRAP.md"))).toBe(false);
      expect(isWakeUpGreeting("Wake up, my friend.", 0)).toBe(false);
    });
  });

  describe("getCannedFirstGreeting", () => {
    it("returns the expected greeting string", () => {
      const greeting = getCannedFirstGreeting();
      expect(greeting).toBe(CANNED_FIRST_GREETING);
      expect(greeting).toContain("brand new");
      expect(greeting).toContain("no name, no memories");
    });
  });
});

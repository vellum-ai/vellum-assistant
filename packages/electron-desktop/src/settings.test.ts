import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

mock.module("electron", () => ({ default: {} }));

const { createAppSettingsStore } = await import("./settings");

let temporaryDirectory: string | null = null;

afterEach(async () => {
  if (temporaryDirectory) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("settings persistence", () => {
  test("clears malformed settings and restores schema defaults", async () => {
    temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "vellum-settings-test-"),
    );
    await fs.writeFile(
      path.join(temporaryDirectory, "config.json"),
      "{ malformed",
    );

    const store = createAppSettingsStore({ cwd: temporaryDirectory });

    expect(store.get("theme")).toBe("system");
    expect(store.get("featureFlags")).toEqual({});
  });
});

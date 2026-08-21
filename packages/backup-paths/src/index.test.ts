import { describe, expect, test } from "bun:test";

import {
  deriveSafeOffsiteAncestor,
  getDefaultOffsiteBackupsDir,
  resolveDefaultOffsiteDestinations,
} from "./index.js";

describe("Windows offsite backups", () => {
  test("does not guess a OneDrive destination from the environment", () => {
    expect(
      resolveDefaultOffsiteDestinations({
        platform: "win32",
        env: { OneDrive: "C:\\Users\\Example\\OneDrive" },
      }),
    ).toEqual([]);
    expect(
      getDefaultOffsiteBackupsDir({ platform: "win32", env: {} }),
    ).toBeNull();
  });

  test("uses the immediate parent for an explicit destination", () => {
    expect(
      deriveSafeOffsiteAncestor("D:\\Backups\\Vellum", {
        platform: "win32",
        env: { OneDrive: "C:\\Users\\Example\\OneDrive" },
      }),
    ).toBe("D:\\Backups");
  });
});

describe("other platforms", () => {
  test("keeps iCloud Drive as the encrypted macOS default", () => {
    expect(
      resolveDefaultOffsiteDestinations({
        platform: "darwin",
        env: {},
        homeDir: "/Users/example",
      }),
    ).toEqual([
      {
        path: "/Users/example/Library/Mobile Documents/com~apple~CloudDocs/VellumAssistant/backups",
        encrypt: true,
      },
    ]);
  });

  test("does not claim an implicit offsite destination on Linux", () => {
    expect(
      resolveDefaultOffsiteDestinations({ platform: "linux", env: {} }),
    ).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";

import { isFileUnheld } from "../file-use.js";

describe("isFileUnheld", () => {
  test("returns false when a process holds the file", async () => {
    expect(
      await isFileUnheld("lock", "linux", async () => ({ stdout: "123\n" })),
    ).toBe(false);
  });

  test("uses an exclusive-open probe on Windows", async () => {
    let invocation: { command: string; args: string[] } | undefined;
    expect(
      await isFileUnheld(
        "C:\\Example Workspace\\.git\\index.lock",
        "win32",
        async (command, args) => {
          invocation = { command, args };
          return { stdout: "" };
        },
      ),
    ).toBe(true);
    expect(invocation?.command).toBe("powershell.exe");
    expect(invocation?.args.at(-1)).toBe(
      "C:\\Example Workspace\\.git\\index.lock",
    );
  });

  test("returns false when Windows reports a sharing violation", async () => {
    expect(
      await isFileUnheld("lock", "win32", async () => {
        throw Object.assign(new Error("held"), { code: 1 });
      }),
    ).toBe(false);
  });

  test("fails closed when the Windows probe errors", async () => {
    expect(
      await isFileUnheld("lock", "win32", async () => {
        throw Object.assign(new Error("probe failed"), { code: 2 });
      }),
    ).toBe(false);
  });

  test("returns true when lsof reports no holder", async () => {
    expect(
      await isFileUnheld("lock", "linux", async () => {
        throw Object.assign(new Error("no matches"), { code: 1 });
      }),
    ).toBe(true);
  });

  test("treats lsof errors as unheld to match prior behavior", async () => {
    expect(
      await isFileUnheld("lock", "linux", async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }),
    ).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";

import { isFileUnheld } from "../file-use.js";

describe("isFileUnheld", () => {
  test("returns false when a process holds the file", async () => {
    expect(await isFileUnheld("lock", async () => ({ stdout: "123\n" }))).toBe(
      false,
    );
  });

  test("returns true when lsof reports no holder", async () => {
    expect(
      await isFileUnheld("lock", async () => {
        throw Object.assign(new Error("no matches"), { code: 1 });
      }),
    ).toBe(true);
  });

  test("fails closed when lsof is unavailable", async () => {
    expect(
      await isFileUnheld("lock", async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }),
    ).toBe(false);
  });

  test("fails closed when lsof reports an error", async () => {
    expect(
      await isFileUnheld("lock", async () => {
        throw Object.assign(new Error("permission denied"), {
          code: 1,
          stderr: "permission denied",
        });
      }),
    ).toBe(false);
  });
});

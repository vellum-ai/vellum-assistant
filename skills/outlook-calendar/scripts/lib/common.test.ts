import { test, expect, spyOn } from "bun:test";

import { ok, printError } from "./common.js";

/** Capture everything written to stdout while running `fn`. */
function captureStdout(fn: () => void): string {
  const writes: string[] = [];
  const spy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return writes.join("");
}

test("ok includes the account field when an account is provided", () => {
  const out = captureStdout(() => {
    ok(
      "No events found in the specified time range for user@example.com.",
      "user@example.com",
    );
  });
  expect(JSON.parse(out)).toEqual({
    ok: true,
    data: "No events found in the specified time range for user@example.com.",
    account: "user@example.com",
  });
});

test("ok omits the account field when no account is known", () => {
  const out = captureStdout(() => {
    ok({ value: [] });
  });
  const parsed = JSON.parse(out);
  expect(parsed).toEqual({ ok: true, data: { value: [] } });
  expect(parsed.account).toBeUndefined();
});

test("printError includes the account field and exits non-zero", () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code}`);
  }) as never);
  try {
    const out = captureStdout(() => {
      expect(() => printError("boom", "work@example.com")).toThrow("exit:1");
    });
    expect(JSON.parse(out)).toEqual({
      ok: false,
      error: "boom",
      account: "work@example.com",
    });
  } finally {
    exitSpy.mockRestore();
  }
});

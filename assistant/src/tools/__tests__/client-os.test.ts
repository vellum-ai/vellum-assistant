/**
 * `desktopClientName` names the desktop client in host tool errors ("Connect a
 * Linux client to use host_bash..."), so every desktop surface must name
 * itself rather than falling through to macOS.
 */

import { describe, expect, test } from "bun:test";

import { desktopClientName } from "../client-os.js";

describe("desktopClientName", () => {
  test("names Linux from the client OS", () => {
    expect(desktopClientName({ clientOs: "linux" })).toBe("Linux");
  });

  test("names Linux from the transport interface", () => {
    expect(desktopClientName({ transportInterface: "linux" })).toBe("Linux");
  });

  test("names Windows from the client OS", () => {
    expect(desktopClientName({ clientOs: "windows" })).toBe("Windows");
  });

  test("falls back to macOS", () => {
    expect(desktopClientName({ transportInterface: "telegram" })).toBe("macOS");
  });
});

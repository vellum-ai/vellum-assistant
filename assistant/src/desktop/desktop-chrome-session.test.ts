import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { configureDesktopChromeFrame } from "./desktop-chrome-session.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["{truncated", "[]", '{"browser":[]}'])(
  "leaves unreadable or malformed preferences untouched: %s",
  (contents) => {
    const directory = mkdtempSync(join(tmpdir(), "desktop-frame-"));
    directories.push(directory);
    mkdirSync(join(directory, "Default"));
    const path = join(directory, "Default", "Preferences");
    writeFileSync(path, contents);

    expect(() => configureDesktopChromeFrame(directory)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(contents);
  },
);

test("does not rewrite an already configured profile", () => {
  const directory = mkdtempSync(join(tmpdir(), "desktop-frame-"));
  directories.push(directory);
  mkdirSync(join(directory, "Default"));
  const path = join(directory, "Default", "Preferences");
  const contents =
    '{ "browser": { "custom_chrome_frame": true }, "profile": { "exit_type": "Crashed" } }';
  writeFileSync(path, contents);

  configureDesktopChromeFrame(directory);

  expect(readFileSync(path, "utf8")).toBe(contents);
});

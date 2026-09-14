import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { writeDesktopChromePolicy } from "./desktop-chrome-policy.js";

const directories: string[] = [];
function policyDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "desktop-chrome-policy-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

test("preserves unrelated policies and does not rewrite on repeated startup", () => {
  const directory = policyDirectory();
  const path = join(directory, "vellum-desktop.json");
  const otherPath = join(directory, "organization.json");
  const unrelated = '{ "HomepageLocation": "https://example.com" }\n';
  writeFileSync(otherPath, unrelated);
  writeFileSync(path, JSON.stringify({ DownloadRestrictions: 1 }));

  writeDesktopChromePolicy(directory);
  const content = readFileSync(path, "utf8");
  expect(JSON.parse(content).DownloadRestrictions).toBe(1);
  expect(readFileSync(otherPath, "utf8")).toBe(unrelated);
  expect(readdirSync(directory).sort()).toEqual([
    "organization.json",
    "vellum-desktop.json",
  ]);

  const before = statSync(path);
  writeDesktopChromePolicy(directory);
  expect(readFileSync(path, "utf8")).toBe(content);
  expect(statSync(path).ino).toBe(before.ino);
  expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
});

test("creates missing policy directories for a fresh desktop", () => {
  const directory = join(policyDirectory(), "policies", "managed");
  writeDesktopChromePolicy(directory);
  expect(readdirSync(directory)).toEqual(["vellum-desktop.json"]);
  expect(statSync(join(directory, "vellum-desktop.json")).mode & 0o777).toBe(
    0o644,
  );
});

test.each(["{broken", "[]", "null", "false"])(
  "leaves invalid existing policy content untouched: %s",
  (content) => {
    const directory = policyDirectory();
    const path = join(directory, "vellum-desktop.json");
    writeFileSync(path, content);
    expect(() => writeDesktopChromePolicy(directory)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(readdirSync(directory)).toEqual(["vellum-desktop.json"]);
  },
);

/**
 * Shared reader for the per-target xcconfigs the bundle-id guards pin against.
 *
 * Every appex restates its host app's `PRODUCT_BUNDLE_IDENTIFIER` and
 * `APP_GROUP_ID`, so each extension gets a guard that reads both sides the same
 * way. The reader lives here rather than once per guard.
 */
import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_DIR = join(import.meta.dir, "../../App/App/Config");

export function readSetting(xcconfig: string, key: string): string {
  const contents = readFileSync(join(CONFIG_DIR, xcconfig), "utf8");
  const line = contents
    .split("\n")
    .find((entry) => entry.startsWith(`${key} =`));
  expect(line).toBeDefined();
  return line!.slice(key.length + 3).trim();
}

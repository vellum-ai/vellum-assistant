import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { findPackageDir } from "./package-runtime-packages";

test("locates native sharp packages through their exported binary", () => {
  const basedir = mkdtempSync(path.join(tmpdir(), "sharp-package-resolution-"));
  const packageName = "@img/sharp-win32-x64";
  const packageDir = path.join(
    basedir,
    "node_modules",
    "@img",
    "sharp-win32-x64",
  );
  mkdirSync(path.join(packageDir, "lib"), { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: packageName,
      exports: { "./sharp.node": "./lib/sharp-win32-x64.node" },
    }),
  );
  writeFileSync(
    path.join(packageDir, "lib", "sharp-win32-x64.node"),
    "fixture",
  );

  try {
    expect(() => Bun.resolveSync(packageName, basedir)).toThrow();
    expect(findPackageDir(`${packageName}/sharp.node`, basedir)).toBe(
      realpathSync(packageDir),
    );
  } finally {
    rmSync(basedir, { recursive: true, force: true });
  }
});

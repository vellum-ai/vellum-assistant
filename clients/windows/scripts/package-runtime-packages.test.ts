import path from "node:path";
import { expect, test } from "bun:test";

import { findPackageDir } from "./package-runtime-packages";

test("locates native sharp packages through their exported binary", () => {
  const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
  const platform = process.platform === "win32" ? "win32" : process.platform;
  const packageName = `sharp-${platform}-${process.arch}`;
  const sharpPackageDir = findPackageDir(
    "sharp",
    path.join(repoRoot, "assistant"),
  );

  expect(
    findPackageDir(`@img/${packageName}/sharp.node`, sharpPackageDir),
  ).toEndWith(path.join("@img", packageName));
});

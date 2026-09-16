#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildBundledPluginPackages } from "./bundled-plugin-packages.js";

const repoRoot = resolve(import.meta.dir, "../..");
const output = {
  version: 1,
  packages: buildBundledPluginPackages(repoRoot),
};

if (process.argv.includes("--check")) {
  console.log("✓ Local marketplace packages are valid");
} else {
  writeFileSync(
    join(
      repoRoot,
      "assistant",
      "src",
      "cli",
      "lib",
      "bundled-plugin-packages.json",
    ),
    `${JSON.stringify(output, null, 2)}\n`,
  );
  console.log("✓ Generated bundled local plugin packages");
}

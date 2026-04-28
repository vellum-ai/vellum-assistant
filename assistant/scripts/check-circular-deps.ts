#!/usr/bin/env bun
/**
 * Detect circular dependencies in the assistant package using madge.
 *
 * Usage:
 *   bun run lint:circular            # exits 1 when cycles exist
 *   bun run lint:circular -- --json  # machine-readable output
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";

const assistantRoot = resolve(import.meta.dirname, "..");
const tsConfig = resolve(assistantRoot, "tsconfig.json");

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");

const cmd = [
  "bunx",
  "madge",
  "--circular",
  "--extensions",
  "ts,tsx",
  "--ts-config",
  tsConfig,
  jsonMode ? "--json" : "",
  resolve(assistantRoot, "src"),
]
  .filter(Boolean)
  .join(" ");

try {
  const output = execSync(cmd, {
    cwd: assistantRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (jsonMode) {
    const cycles: string[][] = JSON.parse(output);
    if (cycles.length > 0) {
      console.log(JSON.stringify(cycles, null, 2));
      console.error(`\n✗ Found ${cycles.length} circular dependency chain(s)`);
      process.exit(1);
    }
  }

  console.log("✓ No circular dependencies detected");
  process.exit(0);
} catch (error: unknown) {
  const execError = error as {
    stdout?: string;
    stderr?: string;
    status?: number;
  };

  // madge exits non-zero when it finds cycles
  if (execError.stdout) {
    if (jsonMode) {
      try {
        const cycles: string[][] = JSON.parse(execError.stdout);
        console.log(JSON.stringify(cycles, null, 2));
        console.error(
          `\n✗ Found ${cycles.length} circular dependency chain(s)`,
        );
      } catch {
        process.stdout.write(execError.stdout);
      }
    } else {
      process.stdout.write(execError.stdout);
    }
  }

  if (execError.stderr) {
    process.stderr.write(execError.stderr);
  }

  process.exit(execError.status ?? 1);
}

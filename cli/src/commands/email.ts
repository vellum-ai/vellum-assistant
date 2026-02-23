import { spawn } from "child_process";
import { existsSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";

const _require = createRequire(import.meta.url);

/**
 * Resolve the assistant entry point so we can delegate `email` subcommands.
 *
 * Search order:
 *   1. Source tree:  cli/src/commands/ → ../../../assistant/src/index.ts
 *   2. bunx layout: @vellumai/cli/src/commands/ → ../../../../vellum/src/index.ts
 *   3. require.resolve("vellum/package.json") → derive src/index.ts
 */
function resolveAssistantIndex(): string {
  // Source tree: cli/src/commands/ -> ../../.. -> repo root -> assistant/src/index.ts
  const sourceTreeIndex = join(import.meta.dir, "..", "..", "..", "assistant", "src", "index.ts");
  if (existsSync(sourceTreeIndex)) {
    return sourceTreeIndex;
  }

  // bunx layout: @vellumai/cli/src/commands/ -> ../../../.. -> node_modules/ -> vellum/src/index.ts
  const bunxIndex = join(import.meta.dir, "..", "..", "..", "..", "vellum", "src", "index.ts");
  if (existsSync(bunxIndex)) {
    return bunxIndex;
  }

  try {
    const vellumPkgPath = _require.resolve("vellum/package.json");
    const candidate = join(dirname(vellumPkgPath), "src", "index.ts");
    if (existsSync(candidate)) {
      return candidate;
    }
  } catch {
    // resolve failed
  }

  throw new Error(
    "Could not locate the vellum assistant. " +
      "Ensure you are running from the source tree or that the 'vellum' package is installed.",
  );
}

export async function email(): Promise<void> {
  const assistantIndex = resolveAssistantIndex();
  const args = process.argv.slice(3); // everything after "email"

  const child = spawn("bun", ["run", assistantIndex, "email", ...args], {
    stdio: "inherit",
    env: process.env,
  });

  await new Promise<void>((resolve, reject) => {
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        process.exitCode = code ?? 1;
        resolve();
      }
    });
    child.on("error", reject);
  });
}

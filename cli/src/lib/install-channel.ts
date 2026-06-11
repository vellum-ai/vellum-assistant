import { accessSync, constants, readFileSync } from "node:fs";
import path from "node:path";

// Must stay in sync with WRAPPER_MARKER in apps/macos/src/main/cli-path-installer.ts.
// It cannot be imported — the npm tarball only includes cli/.
export const WRAPPER_MARKER = "# vellum-cli-wrapper v1";

/**
 * Resolve the `vellum` executable the shell would run, mirroring how
 * `spawnSync("vellum", …)` in resolveLatestAndMaybeSelfUpdate
 * (cli/src/commands/upgrade.ts) resolves the re-exec: first PATH entry
 * containing an executable `vellum` file wins.
 */
export function findVellumOnPath(
  pathEnv: string = process.env.PATH ?? "",
): string | null {
  for (const dir of pathEnv.split(":")) {
    if (dir === "") continue;
    const candidate = path.join(dir, "vellum");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Missing or not executable — keep scanning.
    }
  }
  return null;
}

export type InstallChannel = "app-wrapper" | "standalone" | "none";

/**
 * Classify how the `vellum` on PATH was installed: `app-wrapper` when it is
 * the macOS app's locator-based wrapper script, `standalone` for any other
 * executable (e.g. a bun-global shim), `none` when no `vellum` resolves.
 */
export function detectInstallChannel(pathEnv?: string): {
  channel: InstallChannel;
  binPath: string | null;
} {
  const binPath = findVellumOnPath(pathEnv);
  if (binPath === null) return { channel: "none", binPath: null };

  let content: string;
  try {
    content = readFileSync(binPath, "utf8");
  } catch {
    return { channel: "standalone", binPath };
  }
  return {
    channel: content.includes(WRAPPER_MARKER) ? "app-wrapper" : "standalone",
    binPath,
  };
}

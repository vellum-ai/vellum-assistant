import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { getCliLocatorPath, shQuote } from "./cli-installer";

/** Ownership/migration marker embedded in every wrapper we write. */
export const WRAPPER_MARKER = "# vellum-cli-wrapper v1";

/** Directory the wrapper is installed into. */
export function getWrapperDir(): string {
  return path.join(homedir(), ".local", "bin");
}

/** Absolute path of the `vellum` PATH wrapper. */
export function getWrapperPath(): string {
  return path.join(getWrapperDir(), "vellum");
}

/**
 * Build the POSIX sh wrapper installed at `~/.local/bin/vellum`. The script
 * is machine-stable: all machine-specific paths flow through the locator
 * file, which the app rewrites on every launch — except the locator path
 * itself, which is embedded here.
 */
export function buildWrapperScript(): string {
  return [
    "#!/bin/sh",
    WRAPPER_MARKER,
    '# Installed by Vellum.app ("Install vellum Command"). Safe to delete.',
    `LOCATOR=${shQuote(getCliLocatorPath())}`,
    'if [ ! -f "$LOCATOR" ]; then',
    '  echo "vellum: CLI not set up yet. Launch Vellum.app once to finish setup." >&2',
    "  exit 1",
    "fi",
    '. "$LOCATOR"',
    'if [ ! -x "$VELLUM_BUN" ] || [ ! -e "$VELLUM_CLI_BIN" ]; then',
    '  echo "vellum: installation is incomplete. Launch Vellum.app once to repair it." >&2',
    "  exit 1",
    "fi",
    'exec "$VELLUM_BUN" "$VELLUM_CLI_BIN" "$@"',
    "",
  ].join("\n");
}

export type WrapperOwnership = "ours" | "foreign" | "absent";

/**
 * Classify what sits at the wrapper path. Unreadable-but-present files and
 * marker-less symlink targets (e.g. an npm prefix pointed at `~/.local`)
 * read as `foreign` so we never clobber them.
 */
export function readWrapperOwnership(): WrapperOwnership {
  let content: string;
  try {
    content = readFileSync(getWrapperPath(), "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "absent"
      : "foreign";
  }
  return content.includes(WRAPPER_MARKER) ? "ours" : "foreign";
}

/**
 * Install (or refresh) the PATH wrapper. Foreign files are never overwritten
 * unless the caller explicitly opts in after confirming with the user.
 */
export function installWrapper(opts: {
  overwriteForeign: boolean;
}): "installed" | "needs-overwrite-confirmation" {
  mkdirSync(getWrapperDir(), { recursive: true });

  if (readWrapperOwnership() === "foreign" && !opts.overwriteForeign) {
    return "needs-overwrite-confirmation";
  }

  const wrapperPath = getWrapperPath();
  const tmpPath = `${wrapperPath}.tmp`;
  writeFileSync(tmpPath, buildWrapperScript());
  chmodSync(tmpPath, 0o755);
  renameSync(tmpPath, wrapperPath);
  return "installed";
}

/** Remove the wrapper, but only if it's one we installed. */
export function uninstallWrapper(): "removed" | "not-ours" | "absent" {
  const ownership = readWrapperOwnership();
  if (ownership === "absent") return "absent";
  if (ownership === "foreign") return "not-ours";

  rmSync(getWrapperPath(), { force: true });
  return "removed";
}

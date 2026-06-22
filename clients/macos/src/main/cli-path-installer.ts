import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  ensureCliInstalled,
  getCliLocatorPath,
  isCliInstalled,
  shQuote,
  writeFileAtomicSync,
} from "./cli-installer";
import {
  findExecutablesInPath,
  resolveShellPath,
  splitPathEntries,
} from "./shell-path";

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
 * Classify what sits at the wrapper path. Anything present that can't be
 * read or lacks the marker — unreadable files, dangling symlinks,
 * marker-less symlink targets (e.g. an npm prefix pointed at `~/.local`) —
 * reads as `foreign` so we never clobber it. Only a true no-entry is
 * `absent`; lstat is used so dangling symlinks still count as present.
 */
export function readWrapperOwnership(): WrapperOwnership {
  const wrapperPath = getWrapperPath();

  try {
    lstatSync(wrapperPath);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "absent"
      : "foreign";
  }

  let content: string;
  try {
    content = readFileSync(wrapperPath, "utf8");
  } catch {
    return "foreign";
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
  if (readWrapperOwnership() === "foreign" && !opts.overwriteForeign) {
    return "needs-overwrite-confirmation";
  }

  mkdirSync(getWrapperDir(), { recursive: true });
  writeFileAtomicSync(getWrapperPath(), buildWrapperScript(), 0o755);
  return "installed";
}

/**
 * Startup self-heal for PATH-wrapper users: when the wrapper is ours,
 * provision the pinned CLI so a version bump rewrites the locator promptly
 * instead of waiting for the next in-app CLI action. Absent/foreign wrappers
 * keep the lazy install path. Returns whether provisioning ran.
 */
export async function provisionCliForWrapper(): Promise<boolean> {
  if (readWrapperOwnership() !== "ours") return false;
  await ensureCliInstalled();
  return true;
}

export type CliPathInstallState =
  | { kind: "not-installed" }
  | { kind: "foreign-file" }
  | { kind: "installed"; inPath: boolean; runtimeReady: boolean }
  | {
      kind: "shadowed";
      shadowedBy: string;
      inPath: boolean;
      runtimeReady: boolean;
    };

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Determine how the `vellum` command resolves on the user's login-shell
 * PATH. `shadowed` means another executable wins over our wrapper (e.g. an
 * npm-global install earlier in PATH); symlink/case variants that resolve
 * to the wrapper itself don't count. Never throws — when login-shell PATH
 * resolution fails (null), degrades to `installed` with `inPath: false`
 * rather than reporting states we can't actually attest to.
 *
 * `runtimeReady` reports whether the pinned CLI runtime is provisioned; when
 * false the wrapper exists but can't run, and the menu offers a repair path.
 */
export async function getCliPathInstallState(): Promise<CliPathInstallState> {
  const ownership = readWrapperOwnership();
  if (ownership === "absent") return { kind: "not-installed" };
  if (ownership === "foreign") return { kind: "foreign-file" };

  const runtimeReady = isCliInstalled();
  const shellPath = await resolveShellPath();
  if (shellPath === null) {
    return { kind: "installed", inPath: false, runtimeReady };
  }

  const wrapperPath = getWrapperPath();
  const [firstHit] = findExecutablesInPath("vellum", shellPath);
  const firstHitIsWrapper =
    firstHit !== undefined &&
    (firstHit === wrapperPath || realpathOr(firstHit) === realpathOr(wrapperPath));

  const inPath =
    firstHitIsWrapper || splitPathEntries(shellPath).includes(getWrapperDir());

  if (firstHit !== undefined && !firstHitIsWrapper) {
    return { kind: "shadowed", shadowedBy: firstHit, inPath, runtimeReady };
  }
  return { kind: "installed", inPath, runtimeReady };
}

/** Remove the wrapper, but only if it's one we installed. */
export function uninstallWrapper(): "removed" | "not-ours" | "absent" {
  const ownership = readWrapperOwnership();
  if (ownership === "absent") return "absent";
  if (ownership === "foreign") return "not-ours";

  rmSync(getWrapperPath(), { force: true });
  return "removed";
}

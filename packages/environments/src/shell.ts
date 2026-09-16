import { delimiter } from "node:path";

export interface ShellInvocation {
  command: string;
  args: string[];
}

export interface ShellSpawnFlags {
  detached: boolean;
  windowsHide: true;
}

const WINDOWS_UTF8_PREAMBLE =
  "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; " +
  "$OutputEncoding = [System.Text.Encoding]::UTF8; " +
  "$global:LASTEXITCODE = 0;";

const WINDOWS_EXIT_STATUS_SUFFIX = `
$__vellumCommandSucceeded = $?
$__vellumNativeExitCode = $LASTEXITCODE
if (-not $__vellumCommandSucceeded) {
  if ($__vellumNativeExitCode -ne 0) { exit $__vellumNativeExitCode }
  exit 1
}
exit 0`;

export function buildShellInvocation(
  command: string,
  hostPlatform: NodeJS.Platform = process.platform,
  windowsExecutable = "powershell.exe",
): ShellInvocation {
  if (hostPlatform === "win32") {
    return {
      command: windowsExecutable,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(
          `${WINDOWS_UTF8_PREAMBLE}\n${command}${WINDOWS_EXIT_STATUS_SUFFIX}`,
          "utf16le",
        ).toString("base64"),
      ],
    };
  }
  return { command: "bash", args: ["-c", "--", command] };
}

/**
 * Spawn flags for assistant-owned shell children (sandbox bash, local
 * host_bash fallback, sanitized CLI bash, skill runners, scheduled scripts).
 *
 * POSIX uses a new process group so timeout/abort can SIGKILL the tree via
 * `-pid`. Windows process trees are torn down with `taskkill /T`, which does
 * not need a detached process. Combining `DETACHED_PROCESS`,
 * `CREATE_NO_WINDOW`, and piped stdio on Windows can emit `close` with exit
 * 0 and empty pipes without running the encoded command.
 */
export function buildShellSpawnFlags(
  hostPlatform: NodeJS.Platform = process.platform,
): ShellSpawnFlags {
  return {
    detached: hostPlatform !== "win32",
    windowsHide: true,
  };
}

export function pathListDelimiter(
  hostPlatform: NodeJS.Platform = process.platform,
): string {
  return hostPlatform === process.platform
    ? delimiter
    : hostPlatform === "win32"
      ? ";"
      : ":";
}

export function prependUniquePathEntries(
  value: string | undefined,
  entries: readonly string[],
  hostPlatform: NodeJS.Platform = process.platform,
): string {
  const separator = pathListDelimiter(hostPlatform);
  const current = value?.split(separator).filter(Boolean) ?? [];
  const missing = entries.filter((entry) => !current.includes(entry));
  return [...missing, ...current].join(separator);
}

/**
 * Windows host_bash adapter: runs the wire-contract command strings through
 * Windows PowerShell via the shared host shell executor.
 *
 * The host_bash contract carries an opaque command string; on Windows it is
 * executed by powershell.exe with no fallback to Bash or another shell. A
 * missing PowerShell binary surfaces as an error result, never a different
 * interpreter.
 */

import type { HostProxyExecutor } from "@vellumai/electron-desktop/host-proxy/router";
import {
  createHostShellExecutor,
  type HostShellSpec,
} from "@vellumai/electron-desktop/host-proxy/executors/host-shell-executor";

/** Windows PowerShell ships with every supported Windows version. */
const POWERSHELL_EXECUTABLE = "powershell.exe";

/**
 * Windows PowerShell writes redirected stdout/stderr using
 * [Console]::OutputEncoding (the OEM code page by default), while the shared
 * executor decodes the pipes as UTF-8, so output encoding is forced to UTF-8
 * before the user command runs. The try/catch guards hosts where the console
 * handle rejects the setter; $OutputEncoding covers text piped into native
 * commands.
 */
const UTF8_OUTPUT_PREAMBLE =
  "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; " +
  "$OutputEncoding = [System.Text.Encoding]::UTF8; ";

/**
 * -NoProfile and -NonInteractive keep execution deterministic and prompt
 * free; -EncodedCommand carries the command as base64 UTF-16LE so quoting
 * and Unicode survive Windows command-line re-parsing untouched.
 */
const createPowerShellSpec = (
  executable: string = POWERSHELL_EXECUTABLE,
): HostShellSpec => ({
  buildSpawn: (command) => ({
    file: executable,
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(UTF8_OUTPUT_PREAMBLE + command, "utf16le").toString("base64"),
    ],
  }),
});

export const createWindowsHostBashExecutor = (
  executable?: string,
): HostProxyExecutor =>
  createHostShellExecutor(createPowerShellSpec(executable));

export const hostBashExecutor = createWindowsHostBashExecutor();

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
import { buildShellInvocation } from "@vellumai/environments/shell";

/**
 * -NoProfile and -NonInteractive keep execution deterministic and prompt
 * free; -EncodedCommand carries the command as base64 UTF-16LE so quoting
 * and Unicode survive Windows command-line re-parsing untouched.
 */
const createPowerShellSpec = (
  executable = "powershell.exe",
): HostShellSpec => ({
  buildSpawn: (command) => {
    const invocation = buildShellInvocation(command, "win32", executable);
    return { file: invocation.command, args: invocation.args };
  },
});

export const createWindowsHostBashExecutor = (
  executable?: string,
): HostProxyExecutor =>
  createHostShellExecutor(createPowerShellSpec(executable));

export const hostBashExecutor = createWindowsHostBashExecutor();

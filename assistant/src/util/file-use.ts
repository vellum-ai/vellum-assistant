import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WINDOWS_EXCLUSIVE_OPEN_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class FileUseProbe {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern SafeFileHandle CreateFile(
    string fileName,
    uint desiredAccess,
    uint shareMode,
    IntPtr securityAttributes,
    uint creationDisposition,
    uint flagsAndAttributes,
    IntPtr templateFile);
}
'@

$handle = [FileUseProbe]::CreateFile($args[0], 0, 0, [IntPtr]::Zero, 3, 128, [IntPtr]::Zero)
if (-not $handle.IsInvalid) {
  $handle.Dispose()
  exit 0
}

$errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
if ($errorCode -eq 2) {
  exit 0
}
if ($errorCode -eq 32 -or $errorCode -eq 33) {
  exit 1
}

[Console]::Error.WriteLine($errorCode)
exit 2
`;

type ExecFileResult = { stdout: string };
type ExecFileRunner = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number },
) => Promise<ExecFileResult>;

const runExecFile: ExecFileRunner = async (command, args, options) => {
  const { stdout } = await execFileAsync(command, args, options);
  return { stdout };
};

/** Whether no process holds `path` open. Windows fails closed on probe errors. */
export async function isFileUnheld(
  path: string,
  platform: NodeJS.Platform = process.platform,
  run: ExecFileRunner = runExecFile,
): Promise<boolean> {
  if (platform === "win32") {
    try {
      await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          WINDOWS_EXCLUSIVE_OPEN_SCRIPT,
          path,
        ],
        { encoding: "utf8", timeout: 3000 },
      );
      return true;
    } catch {
      return false;
    }
  }

  try {
    const { stdout } = await run("lsof", ["-t", path], {
      encoding: "utf8",
      timeout: 3000,
    });
    return stdout.length === 0;
  } catch {
    // lsof exits non-zero when no process holds the file. On hosts without
    // lsof this degrades to unconditional removal, matching prior behavior.
    return true;
  }
}

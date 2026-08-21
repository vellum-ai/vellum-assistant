import { readdirSync, readFileSync } from "node:fs";

export interface ProcessTableRow {
  pid: number;
  ppid: number;
  /** Raw command line. Callers must redact it before logging or persistence. */
  command: string;
  rssBytes?: number;
  handleCount?: number;
}

interface WindowsProcessRow {
  ProcessId?: unknown;
  ParentProcessId?: unknown;
  CommandLine?: unknown;
  Name?: unknown;
  WorkingSetSize?: unknown;
  HandleCount?: unknown;
}

function nonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseProcStat(
  content: string,
): { command: string; ppid: number } | null {
  const lparen = content.indexOf("(");
  const rparen = content.lastIndexOf(")");
  if (lparen === -1 || rparen === -1 || rparen < lparen) {
    return null;
  }
  const ppid = Number(content.slice(rparen + 2).split(" ")[1]);
  if (!Number.isInteger(ppid)) {
    return null;
  }
  return { command: content.slice(lparen + 1, rparen), ppid };
}

function listProcessesFromProc(): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }

    try {
      const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (!stat) {
        continue;
      }
      const commandLine = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter(Boolean)
        .join(" ");
      rows.push({
        pid,
        ppid: stat.ppid,
        command: commandLine || stat.command,
      });
    } catch {
      // Processes can exit between reading the directory and their files.
    }
  }
  return rows;
}

export function parsePsProcessTable(output: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3].trim(),
    });
  }
  return rows;
}

export function parseWindowsProcessTable(output: string): ProcessTableRow[] {
  const decoded: unknown = JSON.parse(output.trim().replace(/^\uFEFF/, ""));
  const values = Array.isArray(decoded) ? decoded : [decoded];
  const rows: ProcessTableRow[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const processRow = value as WindowsProcessRow;
    const pid = Number(processRow.ProcessId);
    const ppid = Number(processRow.ParentProcessId);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) {
      continue;
    }
    const commandLine =
      typeof processRow.CommandLine === "string" ? processRow.CommandLine : "";
    const name = typeof processRow.Name === "string" ? processRow.Name : "";
    const rssBytes = nonNegativeNumber(processRow.WorkingSetSize);
    const handleCount = nonNegativeNumber(processRow.HandleCount);
    rows.push({
      pid,
      ppid,
      command: commandLine || name,
      ...(rssBytes == null ? {} : { rssBytes }),
      ...(handleCount == null ? {} : { handleCount }),
    });
  }
  return rows;
}

function runProcessTableCommand(
  command: string[],
  parser: (output: string) => ProcessTableRow[],
): ProcessTableRow[] {
  const result = Bun.spawnSync({
    cmd: command,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Process enumeration failed with exit code ${result.exitCode}`,
    );
  }
  return parser(new TextDecoder().decode(result.stdout));
}

function listProcessesFromPs(): ProcessTableRow[] {
  return runProcessTableCommand(
    ["ps", "-A", "-ww", "-o", "pid=,ppid=,command="],
    parsePsProcessTable,
  );
}

function listProcessesFromPowerShell(): ProcessTableRow[] {
  return runProcessTableCommand(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,Name,WorkingSetSize,HandleCount | ConvertTo-Json -Compress",
    ],
    parseWindowsProcessTable,
  );
}

export function listProcessTable(
  platform: NodeJS.Platform = process.platform,
): ProcessTableRow[] {
  if (platform === "win32") {
    return listProcessesFromPowerShell();
  }
  if (platform === "linux") {
    try {
      return listProcessesFromProc();
    } catch {
      return listProcessesFromPs();
    }
  }
  return listProcessesFromPs();
}

export function readRawProcessCommand(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter(Boolean)
        .join(" ");
    } catch {
      return null;
    }
  }

  try {
    return listProcessTable().find((row) => row.pid === pid)?.command ?? null;
  } catch {
    return null;
  }
}

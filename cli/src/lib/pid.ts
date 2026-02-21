import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

function getProcessesDir(): string {
  return join(homedir(), ".vellum", "processes");
}

export function writePid(name: string, pid: number): void {
  const dir = getProcessesDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(dir, `${name}.pid`), String(pid));
}

export function clearPid(name: string): void {
  const pidFile = join(getProcessesDir(), `${name}.pid`);
  if (existsSync(pidFile)) {
    rmSync(pidFile);
  }
}

export function readPid(name: string): number | null {
  const pidFile = join(getProcessesDir(), `${name}.pid`);
  if (!existsSync(pidFile)) return null;

  try {
    const content = readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function stopProcess(name: string): boolean {
  const pid = readPid(name);
  if (pid === null) return false;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process may already be dead
  }
  clearPid(name);
  return true;
}

export function clearAllPids(): void {
  const dir = getProcessesDir();
  if (!existsSync(dir)) {
    return;
  }
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".pid")) {
      rmSync(join(dir, file));
    }
  }
}

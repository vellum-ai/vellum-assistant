import { existsSync, readFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export async function stop(): Promise<void> {
  const vellumDir = join(homedir(), ".vellum");
  const pidFile = join(vellumDir, "vellum.pid");
  const socketFile = join(vellumDir, "vellum.sock");

  if (!existsSync(pidFile)) {
    console.log("No daemon PID file found — nothing to stop.");
    process.exit(0);
  }

  const pidStr = readFileSync(pidFile, "utf-8").trim();
  const pid = parseInt(pidStr, 10);

  if (isNaN(pid)) {
    console.log("Invalid PID file contents — cleaning up.");
    try { unlinkSync(pidFile); } catch {}
    try { unlinkSync(socketFile); } catch {}
    process.exit(0);
  }

  // Check if process is alive
  try {
    process.kill(pid, 0);
  } catch {
    console.log(`Daemon process ${pid} is not running — cleaning up stale files.`);
    try { unlinkSync(pidFile); } catch {}
    try { unlinkSync(socketFile); } catch {}
    process.exit(0);
  }

  console.log(`Stopping daemon (pid ${pid})...`);
  process.kill(pid, "SIGTERM");

  // Wait up to 2s for graceful exit
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      break; // Process exited
    }
  }

  // Force kill if still alive
  try {
    process.kill(pid, 0);
    console.log("Daemon did not exit after SIGTERM, sending SIGKILL...");
    process.kill(pid, "SIGKILL");
  } catch {
    // Already dead
  }

  // Clean up PID and socket files
  try { unlinkSync(pidFile); } catch {}
  try { unlinkSync(socketFile); } catch {}

  console.log("Daemon stopped.");
}

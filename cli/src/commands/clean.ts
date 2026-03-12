import { detectOrphanedProcesses } from "../lib/orphan-detection";
import { stopProcess } from "../lib/process";

export async function clean(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum clean");
    console.log("");
    console.log(
      "Kill all orphaned vellum processes that are not tracked by any assistant.",
    );
    process.exit(0);
  }

  const orphans = await detectOrphanedProcesses();

  if (orphans.length === 0) {
    console.log("No orphaned processes found.");
    return;
  }

  console.log(
    `Found ${orphans.length} orphaned process${orphans.length === 1 ? "" : "es"}.\n`,
  );

  let killed = 0;
  for (const orphan of orphans) {
    const pid = parseInt(orphan.pid, 10);
    const stopped = await stopProcess(
      pid,
      `${orphan.name} (PID ${orphan.pid})`,
    );
    if (stopped) {
      killed++;
    }
  }

  console.log(`\nCleaned up ${killed} process${killed === 1 ? "" : "es"}.`);
}

#!/usr/bin/env bun
/**
 * Pre-flight reclaim for the standalone dev port (5173).
 *
 * Our standalone dev server binds Vite with `--strictPort`, because
 * `dev:electron` waits on the fixed URL `http://localhost:5173`. The
 * tradeoff is that a *stale* Vite — orphaned to PID 1 when a previous
 * `bun run dev` was force-quit, crashed, or torn down without signals
 * reaching the deeply-nested `bun → bun → vite` leaf — makes the next
 * run fail with "Port 5173 is already in use" instead of recovering.
 *
 * Signal-handler hardening can't fully prevent that: SIGKILL and hard
 * crashes leave orphans no matter what. So we reclaim the port here,
 * right before `concurrently` starts Vite. We only kill a process that
 * actually looks like our dev server (a `vite` listener) — an unrelated
 * service squatting on 5173 is left alone so Vite's strictPort error
 * still surfaces, just with a clearer log above it.
 *
 * Best-effort by design: every failure is caught and logged as a
 * warning, then we return so dev startup is never blocked by this shim.
 */
import { execFileSync } from "node:child_process";

const DEFAULT_PORT = 5173;
const port = Number(process.argv[2] ?? process.env.VELLUM_DEV_PORT ?? DEFAULT_PORT);

/** PIDs currently LISTENing on the port, or [] if none / lookup failed. */
function listenersOn(p: number): number[] {
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${p}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    // lsof exits non-zero when nothing is listening — that's the happy path.
    return [];
  }
}

/** The full command line for a PID, or "" if it can't be read. */
function commandFor(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function reclaim(): void {
  if (!Number.isInteger(port) || port <= 0) return;

  for (const pid of listenersOn(port)) {
    const command = commandFor(pid);

    // Only reclaim our own dev server. Anything else gets a heads-up and is
    // left running so Vite's own strictPort error still fires.
    if (!/\bvite\b/.test(command)) {
      console.warn(
        `[dev] port ${port} held by PID ${pid} (${command || "unknown"}), ` +
          `which is not a Vite dev server — leaving it. Vite will report the conflict.`,
      );
      continue;
    }

    console.log(
      `[dev] reclaiming port ${port} from stale Vite (PID ${pid}) — ` +
        `likely orphaned by a previous dev run.`,
    );
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone between lookup and kill — nothing to do.
      continue;
    }

    // Give it a moment to release the socket; escalate to SIGKILL if it clings.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && listenersOn(port).includes(pid)) {
      execFileSync("sleep", ["0.1"], { stdio: "ignore" });
    }
    if (listenersOn(port).includes(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* raced to exit */
      }
    }
  }
}

try {
  reclaim();
} catch (err) {
  // Never let the reclaim shim block dev startup.
  console.warn(`[dev] port reclaim skipped: ${(err as Error).message}`);
}

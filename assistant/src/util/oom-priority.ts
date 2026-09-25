/**
 * Linux OOM-killer priority for the daemon and everything it spawns.
 *
 * When the container hits its memory limit the kernel kills the process with
 * the highest oom_score: its share of memory plus `oom_score_adj`. The daemon
 * is usually the largest process in the container, so by default it is the
 * victim and the assistant goes down with the runaway tool. Setting the daemon
 * strongly negative and every child non-negative makes the kernel take a tool,
 * desktop, or worker process first and leave the assistant running.
 *
 * Children inherit the parent's value at fork, so every spawn path must reset
 * its child: shell children through `buildShellInvocation`, desktop children
 * through the desktop session's spawn wrapper, workers and Qdrant through a
 * parent-side write right after spawn. Raising a value never needs a
 * capability; lowering one below the inherited value needs CAP_SYS_RESOURCE,
 * which the platform grants and self-hosted Docker (non-root) does not. There
 * the daemon stays at 0, which children at +1000 still lose to.
 */

import { writeFileSync } from "node:fs";

import { CHILD_OOM_SCORE_ADJ } from "@vellumai/environments/shell";

export { CHILD_OOM_SCORE_ADJ };

/** Strongly avoided but still killable as a last resort, unlike -1000. */
export const DAEMON_OOM_SCORE_ADJ = -700;
/** The monitor records the kill, so it outlives everything but the daemon. */
export const MONITOR_OOM_SCORE_ADJ = -500;
/** Workers and Qdrant: kernel default, picked by memory share alone. */
export const WORKER_OOM_SCORE_ADJ = 0;

/**
 * Wrap a command so the child raises its own `oom_score_adj` before it execs.
 * `exec` keeps the pid and process group, so callers that track or kill the
 * child see no difference. Deterministic where a parent-side write after
 * spawn is not: the child may already have forked (Chrome's zygote, a coding
 * agent's tools) before the parent's write lands, and those grandchildren
 * would keep the inherited value. Identity on non-Linux hosts.
 */
export function withOomScoreAdj(
  cmd: readonly string[],
  value: number,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "linux") {
    return [...cmd];
  }
  return [
    "sh",
    "-c",
    `echo ${value} 2>/dev/null >/proc/self/oom_score_adj; exec "$0" "$@"`,
    ...cmd,
  ];
}

/**
 * Write `oom_score_adj` for `pid` (or this process). Returns false where it
 * cannot apply: non-Linux hosts, a process that already exited, or lowering
 * without CAP_SYS_RESOURCE.
 */
export function setOomScoreAdj(
  value: number,
  pid: number | "self" = "self",
  options: { procRoot?: string; platform?: NodeJS.Platform } = {},
): boolean {
  if ((options.platform ?? process.platform) !== "linux") {
    return false;
  }
  try {
    writeFileSync(
      `${options.procRoot ?? "/proc"}/${pid}/oom_score_adj`,
      String(value),
    );
    return true;
  } catch {
    return false;
  }
}

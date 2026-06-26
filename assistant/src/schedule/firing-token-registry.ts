import { randomBytes } from "node:crypto";

/**
 * In-memory registry mapping a per-firing **secret** token to the schedule
 * firing that minted it. A script-mode firing mints a token before its
 * subprocess spawns; the token is injected into that subprocess's env so the
 * script can present it on an LLM escalation (`conversations wake`). The daemon
 * resolves the token back to the firing and applies that schedule's trust level
 * to the woken turn.
 *
 * The token is **recognition, not a gate against the script** — a local IPC
 * connection is already guardian-capable. Two properties keep it honest:
 *
 * - **Secret + random.** The token is 256 bits of CSPRNG output, never the run
 *   id, so it can't be guessed or derived from public attribution data.
 * - **Live-process gating.** A token resolves only while its firing's
 *   subprocess is still running (`exitCode === null`), so a leaked/stale token
 *   cannot apply a firing's trust level after the firing ends. Liveness reads
 *   live process state behind the {@link isAlive} seam.
 *
 * In-memory only: a daemon crash empties the registry on restart, so every
 * prior token rejects (fail-closed). This assumes the daemon spawns the
 * subprocess in-process; if the scheduler is split out, replace the
 * {@link isAlive} seam with a lease.
 */
interface FiringEntry {
  runId: string;
  jobId: string;
  proc: Bun.Subprocess | null;
}

export interface ResolvedFiring {
  runId: string;
  jobId: string;
}

class FiringTokenRegistry {
  private readonly byToken = new Map<string, FiringEntry>();
  private readonly byRunId = new Map<string, FiringEntry>();

  /** Mint a fresh secret token for a firing and register it. */
  mint(runId: string, jobId: string): string {
    const token = randomBytes(32).toString("hex");
    const entry: FiringEntry = { runId, jobId, proc: null };
    this.byToken.set(token, entry);
    this.byRunId.set(runId, entry);
    return token;
  }

  /** Record the live subprocess for a firing so liveness can be checked. */
  attachProc(runId: string, proc: Bun.Subprocess): void {
    const entry = this.byRunId.get(runId);
    if (entry) entry.proc = proc;
  }

  /**
   * Liveness seam: a firing is live while its subprocess has neither exited
   * (`exitCode === null`) nor been signal-killed (`signalCode === null`; a
   * SIGKILL'd timeout leaves `exitCode` null but sets `signalCode`). A firing
   * with no attached subprocess is treated as not-live (fail-closed).
   */
  private isAlive(runId: string): boolean {
    const proc = this.byRunId.get(runId)?.proc;
    return proc != null && proc.exitCode === null && proc.signalCode === null;
  }

  /**
   * Resolve a token to its firing, but only if the token is known AND the
   * firing is still live. Unknown, stale, or post-exit tokens return null.
   */
  resolve(token: string): ResolvedFiring | null {
    const entry = this.byToken.get(token);
    if (!entry) return null;
    if (!this.isAlive(entry.runId)) return null;
    return { runId: entry.runId, jobId: entry.jobId };
  }

  /** Drop a firing's token. Hygiene — correctness comes from {@link isAlive}. */
  revoke(token: string): void {
    const entry = this.byToken.get(token);
    if (!entry) return;
    this.byToken.delete(token);
    this.byRunId.delete(entry.runId);
  }

  /** Drop every entry whose subprocess has exited or been signal-killed. */
  sweep(): void {
    for (const [token, entry] of this.byToken) {
      const proc = entry.proc;
      if (
        proc != null &&
        (proc.exitCode !== null || proc.signalCode !== null)
      ) {
        this.byToken.delete(token);
        this.byRunId.delete(entry.runId);
      }
    }
  }
}

export const firingTokenRegistry = new FiringTokenRegistry();

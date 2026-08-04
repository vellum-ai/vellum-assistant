import { powerMonitor } from "electron";

/**
 * Desktop presence, derived from system-wide HID idle time plus screen
 * lock and suspend.
 *
 * Presence is deliberately NOT window focus. The question this answers is
 * whether a Mac notification banner will reach the user, so someone typing
 * in another app at the same desk is attended and counts as `active`.
 * System idle time also satisfies the rule that only outbound user input
 * resets the timer: a notification appearing on screen is not input, so it
 * leaves the idle clock running.
 *
 * Reference: https://www.electronjs.org/docs/latest/api/power-monitor
 */

export type PresenceState = "active" | "idle" | "away";

/**
 * Doubles as the effective handoff delay, since nothing schedules a
 * deferred re-check. Ten minutes matches Slack's idle default: plain
 * inactivity is a low-confidence signal, worth waiting out rather than
 * buzzing a pocket while the user is still at the desk reading.
 */
export const IDLE_THRESHOLD_MS = 10 * 60_000;

export const POLL_INTERVAL_MS = 30_000;

export const installPresenceMonitor = (
  onReport: (state: PresenceState) => void,
): (() => void) => {
  let locked = false;

  const evaluate = (): PresenceState => {
    if (locked) {
      return "away";
    }
    try {
      // getSystemIdleTime reports seconds.
      const idleMs = powerMonitor.getSystemIdleTime() * 1000;
      return idleMs < IDLE_THRESHOLD_MS ? "active" : "idle";
    } catch {
      // Fail open: a broken read must let the push through, never suppress it.
      return "idle";
    }
  };

  const report = (): void => {
    onReport(evaluate());
  };

  const onLocked = (): void => {
    locked = true;
    report();
  };

  const onUnlocked = (): void => {
    locked = false;
    report();
  };

  powerMonitor.on("lock-screen", onLocked);
  powerMonitor.on("suspend", onLocked);
  powerMonitor.on("unlock-screen", onUnlocked);
  powerMonitor.on("resume", onUnlocked);
  powerMonitor.on("user-did-become-active", onUnlocked);

  // Reports on every tick, not only on transitions: the daemon expires
  // presence after a staleness bound, so a transition-only reporter would
  // go stale while the user is still sitting there and pushes would
  // silently resume.
  const timer = setInterval(report, POLL_INTERVAL_MS);

  return (): void => {
    clearInterval(timer);
    powerMonitor.off("lock-screen", onLocked);
    powerMonitor.off("suspend", onLocked);
    powerMonitor.off("unlock-screen", onUnlocked);
    powerMonitor.off("resume", onUnlocked);
    powerMonitor.off("user-did-become-active", onUnlocked);
  };
};

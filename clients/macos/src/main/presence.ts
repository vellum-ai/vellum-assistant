import { powerMonitor } from "electron";

/**
 * Desktop presence, derived from system-wide HID idle time plus screen
 * lock, suspend, and login-session activation.
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
  // Three independently owned reasons the desktop is unreachable, each
  // cleared only by its paired event. A locked machine that sleeps and wakes
  // is still locked, and becoming the foreground login session says nothing
  // about whether the lock screen is up.
  let locked = false;
  let suspended = false;
  // Assumed active until macOS reports another login session took over:
  // getSystemIdleTime is system-wide, so that session's input would
  // otherwise read as this user's.
  let sessionActive = true;

  const evaluate = (): PresenceState => {
    if (locked || suspended || !sessionActive) {
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

  const onLockScreen = (): void => {
    locked = true;
    report();
  };

  const onUnlockScreen = (): void => {
    locked = false;
    report();
  };

  const onSuspend = (): void => {
    suspended = true;
    report();
  };

  const onResume = (): void => {
    suspended = false;
    report();
  };

  const onSessionBecameActive = (): void => {
    sessionActive = true;
    report();
  };

  const onSessionResigned = (): void => {
    sessionActive = false;
    report();
  };

  powerMonitor.on("lock-screen", onLockScreen);
  powerMonitor.on("unlock-screen", onUnlockScreen);
  powerMonitor.on("suspend", onSuspend);
  powerMonitor.on("resume", onResume);
  powerMonitor.on("user-did-become-active", onSessionBecameActive);
  powerMonitor.on("user-did-resign-active", onSessionResigned);

  // Seeds the daemon before the first tick, so a message sent right after
  // launch is judged against real presence rather than none.
  report();

  // Reports on every tick, not only on transitions: the daemon expires
  // presence after a staleness bound, so a transition-only reporter would
  // go stale while the user is still sitting there and pushes would
  // silently resume.
  const timer = setInterval(report, POLL_INTERVAL_MS);

  return (): void => {
    clearInterval(timer);
    powerMonitor.off("lock-screen", onLockScreen);
    powerMonitor.off("unlock-screen", onUnlockScreen);
    powerMonitor.off("suspend", onSuspend);
    powerMonitor.off("resume", onResume);
    powerMonitor.off("user-did-become-active", onSessionBecameActive);
    powerMonitor.off("user-did-resign-active", onSessionResigned);
  };
};

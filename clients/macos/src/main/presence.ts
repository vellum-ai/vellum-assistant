import { powerMonitor } from "electron";

import log from "./logger";

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

// Only shifts getSystemIdleState between "active" and "idle", a boundary this
// module takes from IDLE_THRESHOLD_MS instead, so the value is immaterial: the
// call is made for its "locked" answer.
const SYSTEM_IDLE_STATE_THRESHOLD_SECONDS = 60;

type SystemIdleState = ReturnType<typeof powerMonitor.getSystemIdleState>;

const readSystemIdleState = (): SystemIdleState => {
  try {
    return powerMonitor.getSystemIdleState(SYSTEM_IDLE_STATE_THRESHOLD_SECONDS);
  } catch {
    // Fail open: an unproven lock state must never read as attended.
    return "unknown";
  }
};

type PresencePowerEvent =
  | "lock-screen"
  | "unlock-screen"
  | "suspend"
  | "resume"
  | "user-did-become-active"
  | "user-did-resign-active";

let installed = false;

export const installPresenceMonitor = (
  onReport: (state: PresenceState) => void,
): (() => void) => {
  // A second install would leak the first monitor's interval and listeners
  // and double the report rate, so it hands back a teardown that owns
  // nothing rather than a live second monitor. The caller gets no reports at
  // all from it, which is worth a line in the log.
  if (installed) {
    log.warn("[presence] monitor already installed, ignoring second install");
    return (): void => {};
  }

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
    // The flags alone cannot see a lock that predates them: electron replays
    // no lock-screen event to a listener attached while the Mac is already
    // locked, so a monitor installed behind the lock screen reads as unlocked.
    // Asking the OS covers that and heals a dropped event; the flags stay
    // because they turn on the instant the screen locks rather than at the
    // next tick. Any one of them saying unreachable wins.
    const systemIdleState = readSystemIdleState();
    if (locked || suspended || !sessionActive || systemIdleState === "locked") {
      return "away";
    }
    if (systemIdleState === "unknown") {
      return "idle";
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

  // Attachment is all-or-nothing. A throw partway through would otherwise
  // leave the earlier listeners subscribed with no teardown in anyone's hands,
  // and the next install would stack a second set on top of those stale
  // closures. Every successful attachment is recorded as it happens so the
  // unwind below and the teardown at the end share one detach path.
  const attached: [PresencePowerEvent, () => void][] = [];

  // powerMonitor's typings declare a separate on/off overload per event name
  // and none of them accepts a union, so subscribing by variable goes through
  // the EventEmitter surface it already extends.
  const emitter: NodeJS.EventEmitter = powerMonitor;

  const detachAll = (): void => {
    for (const [event, handler] of attached.splice(0)) {
      emitter.off(event, handler);
    }
  };

  const attach = (event: PresencePowerEvent, handler: () => void): void => {
    emitter.on(event, handler);
    attached.push([event, handler]);
  };

  try {
    attach("lock-screen", onLockScreen);
    attach("unlock-screen", onUnlockScreen);
    attach("suspend", onSuspend);
    attach("resume", onResume);
    attach("user-did-become-active", onSessionBecameActive);
    attach("user-did-resign-active", onSessionResigned);
  } catch (err) {
    // Fail open: no monitor at all means no presence record, which lets the
    // mobile push through. A half-wired one could report a stale `active` and
    // suppress it.
    detachAll();
    throw err;
  }

  // Latched only once the monitor is fully wired. Claiming it up front would
  // leave a throw from any attachment above with the latch set and no teardown
  // in the caller's hands, and nothing else can clear it, so presence would be
  // dead for the life of the process.
  installed = true;

  // Establishes a state immediately instead of waiting out the first tick,
  // so a message sent right after launch is judged against real presence
  // rather than none. This reaches whoever is connected at install time; the
  // caller caches the state to cover assistants that connect later.
  report();

  // Reports on every tick, not only on transitions: the daemon expires
  // presence after a staleness bound, so a transition-only reporter would
  // go stale while the user is still sitting there and pushes would
  // silently resume.
  const timer = setInterval(report, POLL_INTERVAL_MS);

  return (): void => {
    installed = false;
    clearInterval(timer);
    detachAll();
  };
};

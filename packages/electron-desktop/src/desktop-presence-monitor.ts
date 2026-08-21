import { powerMonitor } from "electron";

export type PresenceState = "active" | "idle" | "away";

export const IDLE_THRESHOLD_MS = 10 * 60_000;
export const POLL_INTERVAL_MS = 30_000;

const SYSTEM_IDLE_STATE_THRESHOLD_SECONDS = 60;

type SystemIdleState = ReturnType<typeof powerMonitor.getSystemIdleState>;
type PresencePowerEvent =
  | "lock-screen"
  | "unlock-screen"
  | "suspend"
  | "resume"
  | "user-did-become-active"
  | "user-did-resign-active";

export interface DesktopPresenceLogger {
  warn: (...args: unknown[]) => void;
}

export type InstallDesktopPresenceMonitor = (
  onReport: (state: PresenceState) => void,
) => () => void;

export const createDesktopPresenceMonitor = (
  logger: DesktopPresenceLogger,
): InstallDesktopPresenceMonitor => {
  let installed = false;

  return (onReport): (() => void) => {
    if (installed) {
      logger.warn("[presence] monitor already installed, ignoring second install");
      return (): void => {};
    }

    // Attendance follows system input and reachability, not app focus.
    let locked = false;
    let suspended = false;
    let sessionActive = true;

    const readSystemIdleState = (): SystemIdleState => {
      try {
        return powerMonitor.getSystemIdleState(
          SYSTEM_IDLE_STATE_THRESHOLD_SECONDS,
        );
      } catch {
        // An unproven state must never suppress a notification.
        return "unknown";
      }
    };

    const evaluate = (): PresenceState => {
      const systemIdleState = readSystemIdleState();
      if (
        locked ||
        suspended ||
        !sessionActive ||
        systemIdleState === "locked"
      ) {
        return "away";
      }
      if (systemIdleState === "unknown") {
        return "idle";
      }
      try {
        const idleMs = powerMonitor.getSystemIdleTime() * 1000;
        return idleMs < IDLE_THRESHOLD_MS ? "active" : "idle";
      } catch {
        // A failed idle-time read is not evidence that the user is present.
        return "idle";
      }
    };

    const report = (): void => {
      onReport(evaluate());
    };

    const attached: [PresencePowerEvent, () => void][] = [];
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
      attach("lock-screen", () => {
        locked = true;
        report();
      });
      attach("unlock-screen", () => {
        locked = false;
        report();
      });
      attach("suspend", () => {
        suspended = true;
        report();
      });
      attach("resume", () => {
        suspended = false;
        report();
      });
      attach("user-did-become-active", () => {
        sessionActive = true;
        report();
      });
      attach("user-did-resign-active", () => {
        sessionActive = false;
        report();
      });
    } catch (err) {
      // Never leave a half-installed monitor that could report stale presence.
      detachAll();
      throw err;
    }

    installed = true;
    report();
    // The assistant expires presence after 90 seconds, so unchanged state must
    // be refreshed rather than reported only on transitions.
    const timer = setInterval(report, POLL_INTERVAL_MS);

    return (): void => {
      installed = false;
      clearInterval(timer);
      detachAll();
    };
  };
};

import { getLogger } from "./logger.js";

const log = getLogger("sleep-wake-detector");

/**
 * Detects system sleep/wake transitions using the epoch-gap technique:
 * a periodic timer checks if the elapsed time between ticks far exceeds
 * the expected interval, which indicates the process was suspended.
 */
export class SleepWakeDetector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick: number = 0;

  constructor(
    private onWake: () => void,
    private intervalMs: number = 10_000,
    private thresholdMultiplier: number = 2,
  ) {}

  start(): void {
    this.stop();
    this.lastTick = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastTick;
      this.lastTick = now;

      if (elapsed > this.intervalMs * this.thresholdMultiplier) {
        log.info(
          { elapsedMs: elapsed, expectedMs: this.intervalMs },
          "System wake detected (epoch gap)",
        );
        this.onWake();
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

import { describe, expect, mock, test } from "bun:test";
import {
  DEFAULT_PONG_DEADLINE_MS,
  DEFAULT_PROBE_INTERVAL_MS,
  SlackSocketLiveness,
  type LivenessDeathReason,
} from "./socket-liveness.js";
import type { CancelTimer, ScheduleFn } from "../util/schedule.js";

/**
 * Deterministic replacement for `setTimeout`. Fires callbacks in due order as
 * time advances, so every assertion below is about the watchdog's decisions
 * rather than about real elapsed time.
 */
class FakeClock {
  private current = 0;
  private queue: { fn: () => void; dueAt: number; cancelled: boolean }[] = [];

  readonly now = (): number => this.current;

  readonly schedule: ScheduleFn = (fn, delayMs): CancelTimer => {
    const entry = { fn, dueAt: this.current + delayMs, cancelled: false };
    this.queue.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };

  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.queue
        .filter((e) => !e.cancelled && e.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!due) {
        break;
      }
      this.queue = this.queue.filter((e) => e !== due);
      this.current = due.dueAt;
      due.fn();
    }
    this.current = target;
  }

  get pendingCount(): number {
    return this.queue.filter((e) => !e.cancelled).length;
  }
}

function makeWatchdog() {
  const clock = new FakeClock();
  const deaths: LivenessDeathReason[] = [];
  const roundTrips: number[] = [];
  const ping = mock(() => {});
  const liveness = new SlackSocketLiveness({
    schedule: clock.schedule,
    now: clock.now,
    onDead: (reason) => deaths.push(reason),
    onRoundTrip: (ms) => roundTrips.push(ms),
  });
  return { clock, deaths, roundTrips, ping, liveness };
}

describe("SlackSocketLiveness", () => {
  test("probes the socket once per interval", () => {
    const { clock, ping, liveness } = makeWatchdog();
    liveness.start({ ping });

    expect(ping).toHaveBeenCalledTimes(0);

    clock.advance(DEFAULT_PROBE_INTERVAL_MS);
    expect(ping).toHaveBeenCalledTimes(1);

    // Answer each probe so the deadline never fires and probing continues.
    liveness.notePong();
    clock.advance(DEFAULT_PROBE_INTERVAL_MS);
    expect(ping).toHaveBeenCalledTimes(2);

    liveness.notePong();
    clock.advance(DEFAULT_PROBE_INTERVAL_MS);
    expect(ping).toHaveBeenCalledTimes(3);

    liveness.stop();
  });

  test("declares the connection dead when a probe goes unanswered", () => {
    const { clock, deaths, ping, liveness } = makeWatchdog();
    liveness.start({ ping });

    clock.advance(DEFAULT_PROBE_INTERVAL_MS);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(deaths).toEqual([]);

    // One tick short of the deadline the connection is still trusted.
    clock.advance(DEFAULT_PONG_DEADLINE_MS - 1);
    expect(deaths).toEqual([]);

    clock.advance(1);
    expect(deaths).toEqual(["no pong within deadline"]);
  });

  test("a silent socket that still pongs is never declared dead", () => {
    // The failure mode a passive idle timeout has: a workspace can be quiet
    // for hours while the connection is perfectly healthy. Only the probe
    // answer decides, so no amount of inbound silence trips the watchdog.
    const { clock, deaths, ping, liveness } = makeWatchdog();
    liveness.start({ ping });

    // Advance exactly one probe interval per turn and answer the probe it
    // fires. The deadline armed by each probe outlives this turn and is
    // cancelled by the pong, which is the behaviour under test.
    for (let i = 0; i < 200; i++) {
      clock.advance(DEFAULT_PROBE_INTERVAL_MS);
      liveness.notePong();
    }

    expect(ping).toHaveBeenCalledTimes(200);
    expect(deaths).toEqual([]);

    liveness.stop();
  });

  test("a late pong does not revive an already-dead verdict", () => {
    const { clock, deaths, ping, liveness } = makeWatchdog();
    liveness.start({ ping });

    clock.advance(DEFAULT_PROBE_INTERVAL_MS + DEFAULT_PONG_DEADLINE_MS);
    expect(deaths).toEqual(["no pong within deadline"]);

    liveness.notePong();
    clock.advance(DEFAULT_PROBE_INTERVAL_MS * 5);

    // Death fires once, and the watchdog stopped itself rather than
    // continuing to probe a socket it already condemned.
    expect(deaths).toEqual(["no pong within deadline"]);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  test("treats a ping the socket refuses as an immediate death", () => {
    const { clock, deaths, liveness } = makeWatchdog();
    liveness.start({
      ping: () => {
        throw new Error("socket is closed");
      },
    });

    clock.advance(DEFAULT_PROBE_INTERVAL_MS);

    // No deadline wait: a socket that will not take the frame is already gone.
    expect(deaths).toEqual(["socket rejected the ping frame"]);
  });

  test("reports the measured round trip so the deadline can be re-derived", () => {
    const { clock, roundTrips, ping, liveness } = makeWatchdog();
    liveness.start({ ping });

    clock.advance(DEFAULT_PROBE_INTERVAL_MS);
    clock.advance(42);
    liveness.notePong();

    expect(roundTrips).toEqual([42]);

    liveness.stop();
  });

  test("start() on a running watchdog abandons the previous generation", () => {
    const { clock, deaths, liveness } = makeWatchdog();
    const first = mock(() => {});
    const second = mock(() => {});

    liveness.start({ ping: first });
    clock.advance(DEFAULT_PROBE_INTERVAL_MS / 2);

    liveness.start({ ping: second });
    clock.advance(DEFAULT_PROBE_INTERVAL_MS);

    // The first socket's probe timer must not fire against the new
    // generation, or a reconnect would inherit a stale deadline.
    expect(first).toHaveBeenCalledTimes(0);
    expect(second).toHaveBeenCalledTimes(1);
    expect(deaths).toEqual([]);

    liveness.stop();
  });

  test("lastPongAt records the most recent proof of liveness", () => {
    const { clock, ping, liveness } = makeWatchdog();
    liveness.start({ ping });

    expect(liveness.lastPongAt).toBeUndefined();

    clock.advance(DEFAULT_PROBE_INTERVAL_MS);
    liveness.notePong();
    const first = liveness.lastPongAt;
    expect(first).toBe(DEFAULT_PROBE_INTERVAL_MS);

    clock.advance(DEFAULT_PROBE_INTERVAL_MS);
    liveness.notePong();
    expect(liveness.lastPongAt).toBe(DEFAULT_PROBE_INTERVAL_MS * 2);

    liveness.stop();
  });

  test("a new generation does not inherit the previous socket's proof", () => {
    // Reporting the old socket's timestamp against a fresh connection would
    // claim liveness that the new socket has not demonstrated.
    const { clock, ping, liveness } = makeWatchdog();
    liveness.start({ ping });
    clock.advance(DEFAULT_PROBE_INTERVAL_MS);
    liveness.notePong();
    expect(liveness.lastPongAt).toBeDefined();

    liveness.start({ ping });
    expect(liveness.lastPongAt).toBeUndefined();

    liveness.stop();
  });

  test("stop() cancels every outstanding timer", () => {
    const { clock, deaths, ping, liveness } = makeWatchdog();
    liveness.start({ ping });

    clock.advance(DEFAULT_PROBE_INTERVAL_MS);
    expect(clock.pendingCount).toBeGreaterThan(0);

    liveness.stop();
    expect(clock.pendingCount).toBe(0);

    clock.advance(DEFAULT_PROBE_INTERVAL_MS * 10);
    expect(deaths).toEqual([]);
    expect(ping).toHaveBeenCalledTimes(1);
  });
});

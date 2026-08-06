import { describe, expect, test } from "bun:test";

import { CLOCK_JUMP_FACTOR, HeartbeatMonitor } from "./heartbeat.js";
import "../__tests__/test-preload.js";

const INTERVAL = 41_250;

/** A clock the test advances by hand, so no test waits in real time. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("noteHello", () => {
  test("jitters the first beat across the whole interval", () => {
    // Docs-mandated: without it, every client reconnecting after a Gateway
    // restart beats in lockstep.
    const clock = fakeClock();
    expect(new HeartbeatMonitor(() => 0, clock.now).noteHello(INTERVAL)).toBe(
      0,
    );
    expect(new HeartbeatMonitor(() => 0.5, clock.now).noteHello(INTERVAL)).toBe(
      INTERVAL / 2,
    );
    expect(new HeartbeatMonitor(() => 1, clock.now).noteHello(INTERVAL)).toBe(
      INTERVAL,
    );
  });

  test("records the interval for later checks", () => {
    const monitor = new HeartbeatMonitor(() => 0, fakeClock().now);
    monitor.noteHello(INTERVAL);
    expect(monitor.heartbeatIntervalMs).toBe(INTERVAL);
  });
});

describe("zombie detection", () => {
  test("a beat with no ACK marks the connection dead", () => {
    const clock = fakeClock();
    const monitor = new HeartbeatMonitor(() => 0, clock.now);
    monitor.noteHello(INTERVAL);

    expect(monitor.isZombie()).toBe(false);
    monitor.noteBeatSent();
    expect(monitor.isAwaitingAck).toBe(true);
    // Checked before sending the next beat: one missed ACK is enough.
    expect(monitor.isZombie()).toBe(true);
  });

  test("an ACK clears the window", () => {
    const clock = fakeClock();
    const monitor = new HeartbeatMonitor(() => 0, clock.now);
    monitor.noteHello(INTERVAL);
    monitor.noteBeatSent();
    monitor.noteAck();
    expect(monitor.isZombie()).toBe(false);
    expect(monitor.isAwaitingAck).toBe(false);
  });

  test("reset clears a pending ACK so a fresh socket is not born a zombie", () => {
    // A reconnect that inherited the previous socket's pending ACK would
    // declare the new connection dead on its first beat and loop.
    const clock = fakeClock();
    const monitor = new HeartbeatMonitor(() => 0, clock.now);
    monitor.noteHello(INTERVAL);
    monitor.noteBeatSent();
    expect(monitor.isZombie()).toBe(true);

    monitor.reset();
    expect(monitor.isZombie()).toBe(false);
    expect(monitor.heartbeatIntervalMs).toBeUndefined();
  });
});

describe("clock-jump detection", () => {
  test("ordinary scheduling lag is not a jump", () => {
    const clock = fakeClock();
    const monitor = new HeartbeatMonitor(() => 0, clock.now);
    monitor.noteHello(INTERVAL);
    monitor.noteBeatSent();

    clock.advance(INTERVAL);
    expect(monitor.detectedClockJump()).toBe(false);

    // Still short of the threshold — event-loop congestion routinely delays a
    // timer by a noticeable fraction of its interval.
    clock.advance(INTERVAL * (CLOCK_JUMP_FACTOR - 1) - 1);
    expect(monitor.detectedClockJump()).toBe(false);
  });

  test("a suspended process overshoots and is caught", () => {
    // The laptop-sleep case: the socket still reports open and no close event
    // ever fires, so the late timer is the only early evidence.
    const clock = fakeClock();
    const monitor = new HeartbeatMonitor(() => 0, clock.now);
    monitor.noteHello(INTERVAL);
    monitor.noteBeatSent();

    clock.advance(INTERVAL * CLOCK_JUMP_FACTOR + 1);
    expect(monitor.detectedClockJump()).toBe(true);
  });

  test("a long sleep is caught just the same", () => {
    const clock = fakeClock();
    const monitor = new HeartbeatMonitor(() => 0, clock.now);
    monitor.noteHello(INTERVAL);
    monitor.noteBeatSent();

    clock.advance(8 * 60 * 60 * 1_000);
    expect(monitor.detectedClockJump()).toBe(true);
  });

  test("reports no jump before HELLO or before the first beat", () => {
    const clock = fakeClock();
    const monitor = new HeartbeatMonitor(() => 0, clock.now);
    expect(monitor.detectedClockJump()).toBe(false);

    monitor.noteHello(INTERVAL);
    clock.advance(INTERVAL * 100);
    // No beat has been sent, so there is no gap to measure.
    expect(monitor.detectedClockJump()).toBe(false);
  });
});

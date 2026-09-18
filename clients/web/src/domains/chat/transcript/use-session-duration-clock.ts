import { useSyncExternalStore } from "react";

import { subscribe } from "@/lib/event-bus";
import { isWindowOnScreen } from "@/runtime/window-attention";

const TICK_INTERVAL_MS = 1_000;

type ClockListener = () => void;

const listeners = new Set<ClockListener>();
let clockNow = Date.now();
let intervalId: ReturnType<typeof setInterval> | null = null;
let appVisible = true;
let lifecycleUnsubscribes: Array<() => void> | null = null;

function publishCurrentTime(): void {
  clockNow = Date.now();
  for (const listener of listeners) {
    listener();
  }
}

function stopClock(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

function startClock(): void {
  if (intervalId === null && listeners.size > 0 && appVisible) {
    intervalId = setInterval(() => {
      if (!readAppVisible()) {
        appVisible = false;
        stopClock();
        return;
      }
      publishCurrentTime();
    }, TICK_INTERVAL_MS);
  }
}

function readAppVisible(): boolean {
  return (
    (typeof document === "undefined" ||
      document.visibilityState !== "hidden") &&
    isWindowOnScreen()
  );
}

function subscribeLifecycle(): void {
  if (lifecycleUnsubscribes) {
    return;
  }
  appVisible = readAppVisible();
  lifecycleUnsubscribes = [
    subscribe("app.hidden", () => {
      appVisible = false;
      stopClock();
    }),
    subscribe("app.resume", ({ signal }) => {
      if (signal === "online") {
        return;
      }
      appVisible = true;
      publishCurrentTime();
      startClock();
    }),
  ];
}

function unsubscribeLifecycle(): void {
  lifecycleUnsubscribes?.forEach((unsubscribe) => unsubscribe());
  lifecycleUnsubscribes = null;
}

function subscribeClock(listener: ClockListener): () => void {
  listeners.add(listener);
  clockNow = Date.now();
  subscribeLifecycle();
  startClock();

  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) {
      return;
    }
    stopClock();
    unsubscribeLifecycle();
  };
}

function subscribeDisabled(): () => void {
  return () => {};
}

function getClockSnapshot(): number {
  return clockNow;
}

function getDisabledSnapshot(): null {
  return null;
}

/**
 * Returns one shared coarse clock while this summary is eligible and the app is visible.
 * The caller owns runtime eligibility through `enabled`.
 */
export function useSessionDurationClock(enabled: boolean): number | null {
  return useSyncExternalStore(
    enabled ? subscribeClock : subscribeDisabled,
    enabled ? getClockSnapshot : getDisabledSnapshot,
    getDisabledSnapshot,
  );
}

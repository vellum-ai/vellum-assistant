import { useSyncExternalStore } from "react";

interface BooleanBridgeSource {
  getInitial: () => Promise<boolean>;
  subscribe: (callback: (value: boolean) => void) => () => void;
}

/**
 * Hold a boolean pushed by the desktop bridge while covering the mount race
 * with a pull of main's current value.
 */
export function createBooleanBridgeStore(source: BooleanBridgeSource): {
  getSnapshot: () => boolean;
  useValue: () => boolean;
} {
  let value = false;
  let pushed = false;
  const watchers = new Set<() => void>();

  const record = (next: boolean): void => {
    if (next === value) {
      return;
    }
    value = next;
    for (const watcher of watchers) {
      watcher();
    }
  };

  source.subscribe((next) => {
    pushed = true;
    record(next);
  });
  void source.getInitial().then((initial) => {
    if (!pushed) {
      record(initial);
    }
  });

  const getSnapshot = (): boolean => value;
  const subscribe = (watcher: () => void): (() => void) => {
    watchers.add(watcher);
    return () => {
      watchers.delete(watcher);
    };
  };

  return {
    getSnapshot,
    useValue: () => useSyncExternalStore(subscribe, getSnapshot, () => false),
  };
}

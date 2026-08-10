export interface WindowReadyHandle {
  promise: Promise<void>;
  markLoaded: () => void;
  markShown: () => void;
  release: () => void;
}

/** Track renderer load and first-show readiness independently per window. */
export const createWindowReadiness = <Window extends object>() => {
  const states = new WeakMap<Window, WindowReadyHandle>();
  const alreadyReady = Promise.resolve();

  return {
    arm(win: Window): WindowReadyHandle {
      let loaded = false;
      let shown = false;
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      const resolveWhenReady = (): void => {
        if (loaded && shown) {
          resolve();
        }
      };
      const handle = {
        promise,
        markLoaded: () => {
          loaded = true;
          resolveWhenReady();
        },
        markShown: () => {
          shown = true;
          resolveWhenReady();
        },
        release: resolve,
      };
      states.set(win, handle);
      return handle;
    },
    wait(win: Window): Promise<void> {
      return states.get(win)?.promise ?? alreadyReady;
    },
  };
};

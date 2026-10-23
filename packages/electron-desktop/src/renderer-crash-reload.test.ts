import {
  afterEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import type { BrowserWindow } from "electron";

import { CRASH_LOOP_MS, reloadOnRendererCrash } from "./renderer-crash-reload";

type GoneListener = (
  event: unknown,
  details: { reason: string; exitCode: number },
) => void;

const makeWindow = () => {
  let onGone: GoneListener | undefined;
  const state = { destroyed: false };
  const reload = mock(() => undefined);
  const win = {
    isDestroyed: () => state.destroyed,
    webContents: {
      on: (event: string, listener: GoneListener) => {
        if (event === "render-process-gone") {
          onGone = listener;
        }
      },
      reload,
    },
  } as unknown as BrowserWindow;
  reloadOnRendererCrash(win);
  const crash = (reason = "oom"): void => {
    onGone?.({}, { reason, exitCode: 1 });
  };
  return { crash, reload, state };
};

describe("reloadOnRendererCrash", () => {
  afterEach(() => {
    setSystemTime();
  });

  test("reloads the page when the renderer dies", () => {
    const { crash, reload } = makeWindow();
    crash("oom");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("leaves a clean renderer exit alone", () => {
    const { crash, reload } = makeWindow();
    crash("clean-exit");
    expect(reload).not.toHaveBeenCalled();
  });

  test("leaves a destroyed window alone", () => {
    const { crash, reload, state } = makeWindow();
    state.destroyed = true;
    crash("killed");
    expect(reload).not.toHaveBeenCalled();
  });

  test("stops reloading a renderer that dies again right after a reload", () => {
    setSystemTime(new Date(1_000_000));
    const { crash, reload } = makeWindow();
    crash("crashed");
    setSystemTime(new Date(1_000_000 + CRASH_LOOP_MS - 1));
    crash("crashed");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("reloads again once the crash-loop window has passed", () => {
    setSystemTime(new Date(1_000_000));
    const { crash, reload } = makeWindow();
    crash("oom");
    setSystemTime(new Date(1_000_000 + CRASH_LOOP_MS));
    crash("oom");
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

import { app, screen } from "electron";
import { z } from "zod";
import type { CoachmarkPressRect } from "@vellumai/electron-desktop/companion-platform";
import { getWindowsHelperClient } from "./windows-helper";
import log from "./logger";

export const createCompanionInput = () => {
  const helper = getWindowsHelperClient();
  let press: {
    rects: readonly CoachmarkPressRect[];
    listener: (index: number) => void;
  } | null = null;
  let scrollEnded: (() => void) | null = null;
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  let watching = false;
  const sync = (): void => {
    const next = press !== null || scrollEnded !== null;
    if (next === watching) {
      return;
    }
    watching = next;
    void helper
      .call("companion.watchInput", { enabled: next })
      .catch((error: unknown) => {
        watching = false;
        log.warn("[companion] mouse observation failed:", error);
      });
  };
  const stopScrollTimer = (): void => {
    if (scrollTimer !== null) {
      clearTimeout(scrollTimer);
      scrollTimer = null;
    }
  };
  const awaitScrollEnd = (): void => {
    stopScrollTimer();
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      scrollEnded?.();
    }, 180);
    scrollTimer.unref();
  };
  helper.onNotification(
    "companion.input",
    z.object({
      kind: z.enum(["press", "scroll"]),
      x: z.number(),
      y: z.number(),
    }),
    (event) => {
      if (event.kind === "scroll") {
        if (scrollEnded) {
          awaitScrollEnd();
        }
        return;
      }
      const point = screen.screenToDipPoint(event);
      const index =
        press?.rects.findIndex(
          (rect) =>
            point.x >= rect.x &&
            point.x < rect.x + rect.width &&
            point.y >= rect.y &&
            point.y < rect.y + rect.height,
        ) ?? -1;
      if (index >= 0 && press) {
        const listener = press.listener;
        press = null;
        sync();
        listener(index);
      }
      scrollEnded?.();
    },
  );
  helper.onState((state) => {
    if (state.status !== "running") {
      watching = false;
      return;
    }
    sync();
  });
  app.once("before-quit", () => {
    press = null;
    scrollEnded = null;
    stopScrollTimer();
  });
  return {
    watchCoachmarkPress: (
      rects: readonly CoachmarkPressRect[],
      listener: (index: number) => void,
    ) => {
      press = rects.length ? { rects, listener } : null;
      sync();
    },
    unwatchCoachmarkPress: () => {
      press = null;
      sync();
    },
    watchFrameScroll: (listener: () => void) => {
      scrollEnded = listener;
      sync();
      awaitScrollEnd();
    },
    unwatchFrameScroll: () => {
      scrollEnded = null;
      stopScrollTimer();
      sync();
    },
  };
};

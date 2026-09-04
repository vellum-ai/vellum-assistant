/**
 * What a watch session could read, and how a pick becomes a target.
 *
 * The companion's Teach opens a picker (`companion-capture-picker.tsx`) and
 * this is the main-process half of it: the list the picker draws, and the
 * resolution of a pressed row into the display or window the session is
 * told to read (`WatchCaptureTarget`).
 *
 * **The windows come from the native helper, not from `desktopCapturer`.**
 * The frame the shell draws around a picked window has to follow it, which
 * takes the window's bounds, and `desktopCapturer` names windows without
 * saying where they are. The helper reads the window server's own list
 * (`CaptureSources.swift`), which carries bounds, owner and title in one
 * call, and the shell polls the same call to keep the frame on a window the
 * user is moving.
 *
 * **A Chrome tab is a window with a step in front.** Chrome's scripting
 * interface lists tabs by Chrome's own window id and a tab index, neither of
 * which the window server knows. Picking one has Chrome show that tab and
 * bring its window forward, after which the tab is the frontmost Chrome
 * window with that title, and that window is the target. The step is here so
 * the surface never has to know a tab is not a window.
 *
 * Everything the desktop is asked comes through {@link CaptureSourceDeps}, so
 * the resolution and the parsing can be exercised without a window server, a
 * helper process, or Chrome.
 */

import { app, screen } from "electron";
import { z } from "zod";

import type {
  CompanionCapturePick,
  CompanionCaptureSources,
  ScreenCaptureFrame,
  WatchCaptureTarget,
} from "@vellumai/ipc-contract";

import { runAppleScript } from "./appleScriptExecutor";
import log from "./logger";
import { getSharedCuHelper } from "./sidecar/shared-cu-helper";

/** Chrome, as `NSRunningApplication` names it and as AppleScript addresses it. */
export const CHROME_BUNDLE_ID = "com.google.Chrome";

const boundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

/**
 * One on-screen window as the helper's `captureSources.list` reports it.
 * Bounds are in points, in the window server's global coordinates, which are
 * the coordinates Electron's `screen` and window bounds already use on macOS.
 */
const helperWindowSchema = z.object({
  windowId: z.number().int().nonnegative(),
  pid: z.number().int(),
  app: z.string(),
  bundleId: z.string().optional(),
  appPath: z.string().optional(),
  title: z.string(),
  bounds: boundsSchema,
  displayId: z.number().int().nonnegative().optional(),
  /**
   * Whether the window server is showing it right now. Absent from a helper
   * asked for on-screen windows only, where every entry is; false only in a
   * list asked for with the off-screen windows included.
   */
  onScreen: z.boolean().optional(),
});

export type HelperWindow = z.infer<typeof helperWindowSchema>;

const helperListSchema = z.object({
  windows: z.array(helperWindowSchema),
});

/**
 * The helper's answer, checked at the boundary. A malformed entry drops the
 * whole answer rather than one row: the helper and this shell ship together,
 * so a shape mismatch is a bug to notice, not a window to skip.
 */
export function parseHelperWindows(raw: unknown): HelperWindow[] {
  return helperListSchema.parse(raw).windows;
}

export interface ChromeTab {
  chromeWindowId: number;
  /** One-based, as AppleScript counts tabs. */
  tabIndex: number;
  active: boolean;
  title: string;
}

/**
 * The separator the listing script puts between a tab's fields: the unit
 * separator, which is what it is for. A control character rather than a tab
 * or a comma, because a page title can hold either and cannot hold this.
 */
const FIELD_SEPARATOR = "";

/**
 * Every tab in every Chrome window, one per line: window id, index, whether
 * it is the window's active tab, and its title.
 */
const LIST_CHROME_TABS_SCRIPT = `
tell application id "${CHROME_BUNDLE_ID}"
  set out to ""
  set sep to (ASCII character 31)
  repeat with w in windows
    set wid to id of w
    set ai to active tab index of w
    set i to 1
    repeat with t in tabs of w
      set out to out & wid & sep & i & sep & (ai = i) & sep & (title of t) & linefeed
      set i to i + 1
    end repeat
  end repeat
  return out
end tell
`;

/** The listing script's output, one tab per line. Blank and torn lines are skipped. */
export function parseChromeTabs(stdout: string): ChromeTab[] {
  const tabs: ChromeTab[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const [windowRaw, indexRaw, activeRaw, ...titleParts] =
      line.split(FIELD_SEPARATOR);
    const chromeWindowId = Number(windowRaw);
    const tabIndex = Number(indexRaw);
    if (
      titleParts.length === 0 ||
      !Number.isInteger(chromeWindowId) ||
      !Number.isInteger(tabIndex) ||
      tabIndex < 1
    ) {
      continue;
    }
    tabs.push({
      chromeWindowId,
      tabIndex,
      active: activeRaw === "true",
      // A title that somehow carried the separator is joined back together
      // rather than truncated at it.
      title: titleParts.join(FIELD_SEPARATOR).replace(/\r$/, ""),
    });
  }
  return tabs;
}

/**
 * Show `tabIndex` in Chrome window `chromeWindowId`, bring that window
 * forward, and report where Chrome says the window now is and whether it is
 * still minimized: "minimized, left, top, right, bottom", separated.
 */
const activateChromeTabScript = (
  chromeWindowId: number,
  tabIndex: number,
): string => `
tell application id "${CHROME_BUNDLE_ID}"
  set w to window id ${Math.trunc(chromeWindowId)}
  set active tab index of w to ${Math.trunc(tabIndex)}
  set index of w to 1
  activate
  set sep to (ASCII character 31)
  set b to bounds of w
  return (minimized of w as text) & sep & (item 1 of b) & sep & (item 2 of b) & sep & (item 3 of b) & sep & (item 4 of b)
end tell
`;

/**
 * Where Chrome put the window it was told to show, in Chrome's own words.
 * The one signal that ties a tab to a window the window server knows: the
 * helper lists windows by bounds, and Chrome reports bounds for the window
 * by id, so the two meet on the rectangle rather than on a title two windows
 * can share.
 */
export interface ChromeWindowPlacement {
  minimized: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

/** The activation script's answer, or nothing for an answer that is not one. */
export function parseChromeWindowPlacement(
  stdout: string,
): ChromeWindowPlacement | null {
  const [minimizedRaw, ...edges] = stdout.trim().split(FIELD_SEPARATOR);
  const [left, top, right, bottom] = edges.map((edge) => Number(edge));
  if (
    edges.length !== 4 ||
    [left, top, right, bottom].some((edge) => !Number.isFinite(edge))
  ) {
    return null;
  }
  return {
    minimized: minimizedRaw === "true",
    bounds: {
      x: left as number,
      y: top as number,
      width: (right as number) - (left as number),
      height: (bottom as number) - (top as number),
    },
  };
}

export interface CaptureDisplay {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  primary: boolean;
}

/**
 * Everything this module asks of the desktop, so the tests can answer for it.
 */
export interface CaptureSourceDeps {
  /**
   * The helper's windows: the on-screen ones, or every one it knows with
   * `onScreen` saying which, when a pick has to be told apart from a window
   * on another Space.
   */
  listWindows: (includeOffscreen?: boolean) => Promise<HelperWindow[]>;
  listDisplays: () => CaptureDisplay[];
  listChromeTabs: () => Promise<ChromeTab[]>;
  /**
   * Show the tab and bring its window forward; resolves to where Chrome says
   * that window is, or null when Chrome would not say.
   */
  activateChromeTab: (
    chromeWindowId: number,
    tabIndex: number,
  ) => Promise<ChromeWindowPlacement | null>;
  /**
   * Bring the window to the front: out of the Dock if it is there, its app
   * activated, and the window raised above the app's others. Resolves to
   * whether the window itself was raised; an app that would not take the
   * request is still activated.
   */
  raiseWindow: (windowId: number) => Promise<boolean>;
  /** The icon of the app at `appPath` as a data URL, or nothing. */
  iconFor: (appPath: string) => Promise<string | undefined>;
}

/**
 * Icons by app path, kept for the process. An app's icon does not change
 * while it runs, and the picker asks for the same dozen apps every time it
 * opens.
 */
const iconCache = new Map<string, Promise<string | undefined>>();

const readIcon = (appPath: string): Promise<string | undefined> => {
  const cached = iconCache.get(appPath);
  if (cached !== undefined) {
    return cached;
  }
  const read = app
    .getFileIcon(appPath, { size: "small" })
    .then((image) => (image.isEmpty() ? undefined : image.toDataURL()))
    .catch(() => undefined);
  iconCache.set(appPath, read);
  return read;
};

export const defaultCaptureSourceDeps: CaptureSourceDeps = {
  listWindows: async (includeOffscreen = false) =>
    parseHelperWindows(
      await getSharedCuHelper().call(
        "captureSources.list",
        includeOffscreen ? { includeOffscreen: true } : undefined,
      ),
    ),
  listDisplays: () => {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((display) => ({
      id: display.id,
      bounds: display.bounds,
      primary: display.id === primaryId,
    }));
  },
  listChromeTabs: async () =>
    parseChromeTabs(await runAppleScript(LIST_CHROME_TABS_SCRIPT)),
  activateChromeTab: async (chromeWindowId, tabIndex) =>
    parseChromeWindowPlacement(
      await runAppleScript(activateChromeTabScript(chromeWindowId, tabIndex)),
    ),
  raiseWindow: async (windowId) => {
    const answer = await getSharedCuHelper().call("captureSources.raise", {
      windowId,
    });
    const { raised, reason } =
      typeof answer === "object" && answer !== null
        ? (answer as { raised?: unknown; reason?: unknown })
        : {};
    // The helper says why it left the window where it was, and this is the
    // log someone reads first: the pick was made from here.
    if (raised !== true && typeof reason === "string") {
      log.warn(
        `[companion] helper did not raise window ${windowId}: ${reason}`,
      );
    }
    return raised === true;
  },
  iconFor: readIcon,
};

/** Whether a helper window is one of Chrome's. */
const isChromeWindow = (window: HelperWindow): boolean =>
  window.bundleId === CHROME_BUNDLE_ID;

/**
 * List what a session could read right now, in the order the picker draws
 * it: the displays with the primary first, the Chrome tabs when Chrome has a
 * window up, and every window the helper reports.
 *
 * Chrome is only asked when one of its windows is on screen. Asking is an
 * Apple event, which the first time round is a system prompt about
 * controlling Chrome, and a prompt about an app that is not even running is
 * one nobody asked for. A refusal, or Chrome answering nothing, leaves the
 * tabs out and the rest of the list standing.
 */
export async function listCaptureSources(
  deps: CaptureSourceDeps = defaultCaptureSourceDeps,
): Promise<CompanionCaptureSources> {
  const [windows, displays] = await Promise.all([
    deps.listWindows().catch((err: unknown) => {
      log.warn("[companion] could not list windows for the picker:", err);
      return [] as HelperWindow[];
    }),
    Promise.resolve(deps.listDisplays()),
  ]);

  const chromeWindow = windows.find(isChromeWindow);
  let tabs: ChromeTab[] = [];
  if (chromeWindow !== undefined) {
    try {
      tabs = await deps.listChromeTabs();
    } catch (err) {
      log.info("[companion] Chrome did not list its tabs for the picker:", err);
    }
  }

  const icons = new Map<string, string | undefined>();
  await Promise.all(
    [...new Set(windows.flatMap((w) => (w.appPath ? [w.appPath] : [])))].map(
      async (appPath) => {
        icons.set(appPath, await deps.iconFor(appPath));
      },
    ),
  );
  const iconOf = (appPath: string | undefined): string | undefined =>
    appPath === undefined ? undefined : icons.get(appPath);
  const chromeIcon = iconOf(chromeWindow?.appPath);

  const orderedDisplays = [...displays].sort((a, b) =>
    a.primary === b.primary ? 0 : a.primary ? -1 : 1,
  );

  return {
    displays: orderedDisplays.map((display, index) => ({
      kind: "display",
      displayId: display.id,
      index,
      primary: display.primary,
    })),
    tabs: tabs.map((tab) => ({
      kind: "tab",
      chromeWindowId: tab.chromeWindowId,
      tabIndex: tab.tabIndex,
      title: tab.title,
      ...(chromeIcon === undefined ? {} : { icon: chromeIcon }),
    })),
    windows: windows.map((window) => {
      const icon = iconOf(window.appPath);
      return {
        kind: "window",
        windowId: window.windowId,
        title: window.title,
        app: window.app,
        ...(icon === undefined ? {} : { icon }),
      };
    }),
  };
}

/**
 * The Chrome window showing a tab with `title`, once Chrome has been told to
 * show it, or nothing when no window can be tied to that tab.
 *
 * By the bounds Chrome reports for the window after showing the tab together
 * with the tab's title, and only when exactly one Chrome window the helper
 * knows of, on screen or off, fits both. Without a placement, by title, since a Chrome window is titled after its active tab: the one
 * window with exactly that title, or the one window whose title Chrome
 * decorated around it. Never by z-order, and never one of several alike. The activation brings the tab's window forward when it can, but a
 * window Chrome could not restore (minimized, on another space) stays off the
 * helper's on-screen list, and the frontmost Chrome window is then some
 * other page the user did not pick. Reading nothing is the only honest
 * answer there; the surface tells the user the pick started nothing.
 */
export function chromeWindowFor(
  windows: HelperWindow[],
  title: string,
  placement?: ChromeWindowPlacement | null,
): HelperWindow | undefined {
  const chrome = windows.filter(isChromeWindow);
  // Chrome's own account of the window comes first. A window still
  // minimized after the activation is not on screen at all, whatever else
  // is. Otherwise the window is the one Chrome window at that rectangle
  // with that title, counted across every window the helper knows,
  // on-screen or not: two maximized Chrome windows share a rectangle, and
  // one left on another Space shares the title too, so a match that is not
  // the only one, or is not itself on screen, names nothing for certain.
  if (placement) {
    if (placement.minimized) {
      return undefined;
    }
    const { bounds } = placement;
    const at = chrome.filter(
      (w) =>
        Math.abs(w.bounds.x - bounds.x) <= 2 &&
        Math.abs(w.bounds.y - bounds.y) <= 2 &&
        Math.abs(w.bounds.width - bounds.width) <= 2 &&
        Math.abs(w.bounds.height - bounds.height) <= 2,
    );
    // Exact and decorated titles count together: which of the two Chrome
    // gives a window is not something this side can tell, so a window of
    // either kind beside the other is an ambiguity, not a preference.
    const candidates = at.filter(
      (w) => w.title === title || (title !== "" && w.title.startsWith(title)),
    );
    if (candidates.length !== 1 || candidates[0]?.onScreen === false) {
      return undefined;
    }
    return candidates[0];
  }
  // Without a placement, the title, and only a title that names one window. Two Chrome windows on the same page share a title,
  // and if the picked one stayed off screen the other is the one listed.
  const exact = chrome.filter((w) => w.title === title);
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1 || title === "") {
    return undefined;
  }
  const decorated = chrome.filter((w) => w.title.startsWith(title));
  return decorated.length === 1 ? decorated[0] : undefined;
}

/**
 * How long a pick waits for its window to come to the front before going
 * ahead without it. The helper answers in milliseconds for an app that is
 * answering at all, and gives up on one that is not within a few seconds of
 * its own; the shared helper client's budget is a minute, sized for
 * computer-use actions, and a pick left waiting that long would read as a
 * dead button.
 */
export const RAISE_WAIT_MS = 5_000;

/**
 * Bring a picked window to the front, and carry on either way.
 *
 * The pick is what the user is about to talk about, so it belongs in front
 * of whatever they were looking at when they picked it. The capture does not
 * depend on it: a window the helper could not raise (an app refusing the
 * request, a helper that is down, a helper still trying past `waitMs`) is
 * still read where it is, so this never decides whether the pick resolves.
 * A raise that lands after the wait lands on the window the session is
 * reading anyway, or on a pick the generation guard in `companion-window`
 * has already superseded, which is a window the user chose a moment ago.
 */
export const bringForward = async (
  windowId: number,
  deps: Pick<CaptureSourceDeps, "raiseWindow">,
  waitMs = RAISE_WAIT_MS,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), waitMs);
  });
  try {
    const raise = deps.raiseWindow(windowId);
    const outcome = await Promise.race([raise, expiry]);
    if (outcome === "expired") {
      log.warn(
        `[companion] window ${windowId} is still coming to the front after ${waitMs}ms; not waiting`,
      );
      // The late answer is only worth a line in the log, and its rejection
      // is caught so it never surfaces as an unhandled one.
      raise.then(
        (raised) => {
          if (!raised) {
            log.warn(
              `[companion] window ${windowId} would not come to the front`,
            );
          }
        },
        (err) =>
          log.warn(
            "[companion] could not bring the picked window forward:",
            err,
          ),
      );
    } else if (!outcome) {
      log.warn(`[companion] window ${windowId} would not come to the front`);
    }
  } catch (err) {
    log.warn("[companion] could not bring the picked window forward:", err);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Turn a pressed row into the target the session is told to read, or nothing
 * when it cannot be: a tab whose window Chrome no longer has, or a Chrome
 * that would not take the request.
 *
 * A display is already a target. A window is one too, and comes to the front
 * on the way. A tab is the window showing it, which takes an activation round
 * trip through Chrome and a fresh list from the helper, since the window that
 * shows it may not have been in front (or on screen at all, if minimized)
 * when the picker was drawn; that window comes to the front as well, since
 * Chrome's own activation is of the app and not always of the window.
 */
export async function resolveCapturePick(
  pick: CompanionCapturePick,
  deps: CaptureSourceDeps = defaultCaptureSourceDeps,
): Promise<WatchCaptureTarget | null> {
  if (pick.kind === "display") {
    return { kind: "display", displayId: pick.displayId };
  }
  if (pick.kind === "window") {
    await bringForward(pick.windowId, deps);
    return { kind: "window", windowId: pick.windowId };
  }
  let title = "";
  let placement: ChromeWindowPlacement | null = null;
  try {
    const tab = (await deps.listChromeTabs()).find(
      (t) =>
        t.chromeWindowId === pick.chromeWindowId &&
        t.tabIndex === pick.tabIndex,
    );
    if (tab === undefined) {
      log.warn("[companion] the picked Chrome tab is gone");
      return null;
    }
    title = tab.title;
    placement = await deps.activateChromeTab(
      pick.chromeWindowId,
      pick.tabIndex,
    );
  } catch (err) {
    log.warn("[companion] Chrome would not show the picked tab:", err);
    return null;
  }
  let windows: HelperWindow[];
  try {
    // Every window, so a look-alike on another Space counts against the
    // match rather than hiding behind the on-screen list.
    windows = await deps.listWindows(true);
  } catch (err) {
    log.warn("[companion] could not list windows after showing the tab:", err);
    return null;
  }
  const window = chromeWindowFor(windows, title, placement);
  if (window === undefined) {
    log.warn("[companion] no Chrome window on screen for the picked tab");
    return null;
  }
  // Raised after Chrome has finished its own activation (the script above
  // returns once Chrome has processed it), never alongside it. When Chrome
  // did bring this window forward, the raise finds it already restored and
  // in front and changes nothing; when Chrome activated with another of its
  // windows in front, which happens, this is what puts the tab's window
  // there. Unconditional because the cheap case is a no-op and the check
  // that would skip it (is this window frontmost now?) costs the same trip.
  await bringForward(window.windowId, deps);
  return { kind: "window", windowId: window.windowId };
}

/**
 * Where a window is right now, or nothing when it is not on screen: closed,
 * minimized, or on a space the user has left. The shell's frame polls this
 * to stay on a window the user is moving, and hides while the answer is
 * nothing.
 */
export async function windowBoundsFor(
  windowId: number,
  deps: Pick<CaptureSourceDeps, "listWindows"> = defaultCaptureSourceDeps,
): Promise<HelperWindow["bounds"] | null> {
  const window = (await deps.listWindows()).find(
    (w) => w.windowId === windowId,
  );
  return window === undefined ? null : window.bounds;
}

const capturedFrameSchema = z.object({
  jpegBase64: z.string().min(1),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
});

/**
 * The longest side a shared frame is encoded at. Wide enough that text on a
 * shared window still reads, and no wider: the app resizes every attachment
 * on its way up, and a display's worth of pixels crosses the bridge as JSON.
 */
const SHARED_FRAME_MAX_WIDTH = 1600;
const SHARED_FRAME_MAX_HEIGHT = 1000;

/**
 * One frame of a display or a window, as the helper takes it, or nothing
 * when it could not: the window has gone, the display was unplugged, or
 * Screen Recording is not granted. The refusal is logged rather than thrown,
 * since the caller shares frames on a cadence and one missed frame is not an
 * error the user needs to hear about.
 */
export async function captureTargetFrame(
  target: WatchCaptureTarget,
): Promise<ScreenCaptureFrame | null> {
  const params =
    target.kind === "display"
      ? { displayId: target.displayId }
      : { windowId: target.windowId };
  try {
    return capturedFrameSchema.parse(
      await getSharedCuHelper().call("capture.frame", {
        ...params,
        maxWidth: SHARED_FRAME_MAX_WIDTH,
        maxHeight: SHARED_FRAME_MAX_HEIGHT,
      }),
    );
  } catch (err) {
    log.warn("[companion] could not take a frame of the shared target:", err);
    return null;
  }
}

import { describe, expect, mock, test } from "bun:test";

import type {
  CaptureSourceDeps,
  HelperWindow,
} from "./companion-capture-sources";

// The module reaches Electron for icons and displays, the helper for windows
// and `osascript` for Chrome, none of which run here. Every case hands in its
// own answers through the deps, so these mocks only have to satisfy the
// imports.
mock.module("electron", () => ({
  app: { getFileIcon: async () => ({ isEmpty: () => true }) },
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 0 }) },
}));
mock.module("./logger", () => ({
  default: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
}));
mock.module("./appleScriptExecutor", () => ({
  runAppleScript: async () => "",
}));
mock.module("./sidecar/shared-cu-helper", () => ({
  getSharedCuHelper: () => ({ call: async () => ({ windows: [] }) }),
}));

const {
  CHROME_BUNDLE_ID,
  bringForward,
  chromeWindowFor,
  listCaptureSources,
  parseChromeTabs,
  parseChromeWindowPlacement,
  parseHelperWindows,
  resolveCapturePick,
  windowBoundsFor,
} = await import("./companion-capture-sources");

const SEP = String.fromCharCode(31);

const window = (over: Partial<HelperWindow>): HelperWindow => ({
  windowId: 1,
  pid: 100,
  app: "Notes",
  title: "Untitled",
  bounds: { x: 0, y: 0, width: 600, height: 400 },
  ...over,
});

const chrome = (over: Partial<HelperWindow>): HelperWindow =>
  window({
    app: "Google Chrome",
    bundleId: CHROME_BUNDLE_ID,
    appPath: "/Applications/Google Chrome.app",
    ...over,
  });

/** Deps that answer with what a case hands in and record what was asked. */
const deps = (
  over: Partial<CaptureSourceDeps> = {},
): CaptureSourceDeps & { activated: [number, number][]; raised: number[] } => {
  const activated: [number, number][] = [];
  const raised: number[] = [];
  return {
    listWindows: async () => [],
    listDisplays: () => [],
    listChromeTabs: async () => [],
    activateChromeTab: async (chromeWindowId, tabIndex) => {
      activated.push([chromeWindowId, tabIndex]);
      return null;
    },
    raiseWindow: async (windowId) => {
      raised.push(windowId);
      return true;
    },
    iconFor: async () => undefined,
    ...over,
    activated,
    raised,
  };
};

describe("the helper's window list", () => {
  test("is read as it arrives", () => {
    const raw = {
      windows: [
        {
          windowId: 7,
          pid: 42,
          app: "Notes",
          bundleId: "com.apple.Notes",
          appPath: "/System/Applications/Notes.app",
          title: "Groceries",
          bounds: { x: 10, y: 20, width: 300, height: 200 },
          displayId: 1,
        },
      ],
    };
    expect(parseHelperWindows(raw)).toEqual(raw.windows);
  });

  test("refuses a shape it does not know", () => {
    expect(() =>
      parseHelperWindows({ windows: [{ windowId: "7" }] }),
    ).toThrow();
  });
});

describe("Chrome's tab listing", () => {
  test("reads one tab per line", () => {
    const stdout = [
      ["101", "1", "false", "Inbox"].join(SEP),
      ["101", "2", "true", "Pull request #42"].join(SEP),
      ["202", "1", "true", ""].join(SEP),
      "",
    ].join("\n");
    expect(parseChromeTabs(stdout)).toEqual([
      { chromeWindowId: 101, tabIndex: 1, active: false, title: "Inbox" },
      {
        chromeWindowId: 101,
        tabIndex: 2,
        active: true,
        title: "Pull request #42",
      },
      { chromeWindowId: 202, tabIndex: 1, active: true, title: "" },
    ]);
  });

  test("keeps a title that carries the separator", () => {
    const stdout = ["101", "1", "true", `a${SEP}b`].join(SEP);
    expect(parseChromeTabs(stdout)[0]?.title).toBe(`a${SEP}b`);
  });

  test("skips torn lines and a carriage return", () => {
    const stdout = [
      "garbage",
      ["x", "1", "true", "Bad window"].join(SEP),
      ["101", "0", "true", "Bad index"].join(SEP),
      ["101", "1", "true", "Fine\r"].join(SEP),
    ].join("\n");
    expect(parseChromeTabs(stdout)).toEqual([
      { chromeWindowId: 101, tabIndex: 1, active: true, title: "Fine" },
    ]);
  });
});

describe("listing what a session could read", () => {
  test("puts the primary display first and numbers them from it", async () => {
    const sources = await listCaptureSources(
      deps({
        listDisplays: () => [
          {
            id: 5,
            bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
            primary: false,
          },
          {
            id: 1,
            bounds: { x: 0, y: 0, width: 1440, height: 900 },
            primary: true,
          },
        ],
      }),
    );
    expect(sources.displays).toEqual([
      { kind: "display", displayId: 1, index: 0, primary: true },
      { kind: "display", displayId: 5, index: 1, primary: false },
    ]);
  });

  test("names windows with their app and its icon", async () => {
    const sources = await listCaptureSources(
      deps({
        listWindows: async () => [
          window({
            windowId: 7,
            title: "Groceries",
            appPath: "/System/Applications/Notes.app",
          }),
          window({ windowId: 8, app: "Preview", title: "" }),
        ],
        iconFor: async (appPath) =>
          appPath.endsWith("Notes.app") ? "data:notes" : undefined,
      }),
    );
    expect(sources.windows).toEqual([
      {
        kind: "window",
        windowId: 7,
        title: "Groceries",
        app: "Notes",
        icon: "data:notes",
      },
      { kind: "window", windowId: 8, title: "", app: "Preview" },
    ]);
  });

  /**
   * Asking Chrome is an Apple event, and the first one is a system prompt
   * about controlling Chrome. Nobody is asked about an app with no window up.
   */
  test("does not ask Chrome for tabs unless a Chrome window is on screen", async () => {
    let asked = 0;
    const sources = await listCaptureSources(
      deps({
        listWindows: async () => [window({})],
        listChromeTabs: async () => {
          asked += 1;
          return [];
        },
      }),
    );
    expect(asked).toBe(0);
    expect(sources.tabs).toEqual([]);
  });

  test("lists Chrome's tabs under Chrome's icon when it has a window up", async () => {
    const sources = await listCaptureSources(
      deps({
        listWindows: async () => [chrome({ windowId: 9, title: "Inbox" })],
        listChromeTabs: async () => [
          { chromeWindowId: 101, tabIndex: 1, active: true, title: "Inbox" },
          { chromeWindowId: 101, tabIndex: 2, active: false, title: "Docs" },
        ],
        iconFor: async () => "data:chrome",
      }),
    );
    expect(sources.tabs).toEqual([
      {
        kind: "tab",
        chromeWindowId: 101,
        tabIndex: 1,
        title: "Inbox",
        icon: "data:chrome",
      },
      {
        kind: "tab",
        chromeWindowId: 101,
        tabIndex: 2,
        title: "Docs",
        icon: "data:chrome",
      },
    ]);
  });

  test("leaves the tabs out when Chrome refuses, and the rest standing", async () => {
    const sources = await listCaptureSources(
      deps({
        listWindows: async () => [chrome({ windowId: 9, title: "Inbox" })],
        listChromeTabs: async () => {
          throw new Error("not permitted");
        },
      }),
    );
    expect(sources.tabs).toEqual([]);
    expect(sources.windows).toHaveLength(1);
  });

  test("lists the displays even when the helper cannot list windows", async () => {
    const sources = await listCaptureSources(
      deps({
        listWindows: async () => {
          throw new Error("helper down");
        },
        listDisplays: () => [
          {
            id: 1,
            bounds: { x: 0, y: 0, width: 1440, height: 900 },
            primary: true,
          },
        ],
      }),
    );
    expect(sources.displays).toHaveLength(1);
    expect(sources.windows).toEqual([]);
  });
});

describe("Chrome's account of the shown window", () => {
  test("is read as minimized plus a rectangle", () => {
    expect(
      parseChromeWindowPlacement(
        ["false", "22", "33", "1378", "1117"].join(SEP) + "\n",
      ),
    ).toEqual({
      minimized: false,
      bounds: { x: 22, y: 33, width: 1356, height: 1084 },
    });
    expect(
      parseChromeWindowPlacement(["true", "0", "0", "10", "10"].join(SEP))
        ?.minimized,
    ).toBe(true);
  });

  test("is nothing for an answer that is not one", () => {
    expect(parseChromeWindowPlacement("")).toBeNull();
    expect(
      parseChromeWindowPlacement(["false", "1", "x", "3", "4"].join(SEP)),
    ).toBeNull();
  });
});

describe("the Chrome window for a tab", () => {
  const windows = [
    window({ windowId: 1, title: "Inbox" }),
    chrome({ windowId: 2, title: "Docs" }),
    chrome({ windowId: 3, title: "Inbox" }),
    chrome({ windowId: 4, title: "Inbox - Google Chrome" }),
  ];

  test("is the one titled after it", () => {
    expect(chromeWindowFor(windows, "Inbox")?.windowId).toBe(3);
  });

  test("never a window of another app with the same title", () => {
    expect(chromeWindowFor(windows, "Inbox")?.windowId).not.toBe(1);
  });

  test("tolerates a title Chrome decorated", () => {
    expect(chromeWindowFor(windows, "Inbox - ")?.windowId).toBe(4);
  });

  test("is the one window at the bounds Chrome reports with the tab's title", () => {
    const placed = {
      minimized: false,
      bounds: { x: 0, y: 0, width: 600, height: 400 },
    };
    expect(
      chromeWindowFor(
        [
          chrome({ windowId: 6, title: "Inbox" }),
          chrome({ windowId: 7, title: "Docs" }),
          chrome({
            windowId: 3,
            title: "Inbox",
            bounds: { x: 100, y: 0, width: 600, height: 400 },
          }),
        ],
        "Inbox",
        placed,
      )?.windowId,
    ).toBe(6);
    expect(
      chromeWindowFor(
        [
          chrome({
            windowId: 6,
            title: "Inbox",
            bounds: { x: 100, y: 0, width: 600, height: 400 },
          }),
        ],
        "Inbox",
        placed,
      ),
    ).toBeUndefined();
  });

  /**
   * Two maximized Chrome windows on the same page are one rectangle and one
   * title. The picked one may be the one on another Space, which the helper
   * lists as off screen, so neither is named.
   */
  test("is nothing when an exact and a decorated title share the rectangle", () => {
    const placed = {
      minimized: false,
      bounds: { x: 0, y: 0, width: 600, height: 400 },
    };
    expect(
      chromeWindowFor(
        [
          chrome({ windowId: 6, title: "Inbox" }),
          chrome({ windowId: 9, title: "Inbox - Google Chrome" }),
        ],
        "Inbox",
        placed,
      ),
    ).toBeUndefined();
    expect(
      chromeWindowFor(
        [chrome({ windowId: 9, title: "Inbox - Google Chrome" })],
        "Inbox",
        placed,
      )?.windowId,
    ).toBe(9);
  });

  test("is nothing when a look-alike shares the rectangle and the title", () => {
    const placed = {
      minimized: false,
      bounds: { x: 0, y: 0, width: 600, height: 400 },
    };
    expect(
      chromeWindowFor(
        [
          chrome({ windowId: 6, title: "Inbox", onScreen: true }),
          chrome({ windowId: 8, title: "Inbox", onScreen: false }),
        ],
        "Inbox",
        placed,
      ),
    ).toBeUndefined();
    expect(
      chromeWindowFor(
        [chrome({ windowId: 8, title: "Inbox", onScreen: false })],
        "Inbox",
        placed,
      ),
    ).toBeUndefined();
  });

  test("is nothing while Chrome says the window is still minimized", () => {
    expect(
      chromeWindowFor([chrome({ windowId: 6, title: "Inbox" })], "Inbox", {
        minimized: true,
        bounds: { x: 0, y: 0, width: 600, height: 400 },
      }),
    ).toBeUndefined();
  });

  test("is nothing when two windows carry the exact title", () => {
    expect(
      chromeWindowFor(
        [chrome({ windowId: 6, title: "Inbox" }), ...windows],
        "Inbox",
      ),
    ).toBeUndefined();
  });

  test("is nothing when no title matches, never the frontmost window", () => {
    expect(chromeWindowFor(windows, "Gone")).toBeUndefined();
    expect(chromeWindowFor(windows, "")).toBeUndefined();
  });

  test("is nothing when a decorated title fits more than one window", () => {
    expect(
      chromeWindowFor(
        [chrome({ windowId: 5, title: "Inbox (1)" }), ...windows],
        "Inbox",
      )?.windowId,
    ).toBe(3);
    expect(
      chromeWindowFor(
        [
          chrome({ windowId: 5, title: "Inbox (1)" }),
          chrome({ windowId: 4, title: "Inbox - Google Chrome" }),
        ],
        "Inbox",
      ),
    ).toBeUndefined();
  });

  test("is nothing without a Chrome window", () => {
    expect(chromeWindowFor([window({})], "Inbox")).toBeUndefined();
  });
});

describe("resolving a pick", () => {
  test("a display is already a target, and nothing is brought forward", async () => {
    const d = deps();
    expect(
      await resolveCapturePick({ kind: "display", displayId: 5 }, d),
    ).toEqual({
      kind: "display",
      displayId: 5,
    });
    expect(d.activated).toEqual([]);
    expect(d.raised).toEqual([]);
  });

  test("a window is already a target, and comes to the front", async () => {
    const d = deps();
    expect(
      await resolveCapturePick({ kind: "window", windowId: 8 }, d),
    ).toEqual({
      kind: "window",
      windowId: 8,
    });
    expect(d.raised).toEqual([8]);
    expect(d.activated).toEqual([]);
  });

  test("a window the helper cannot raise is still the target", async () => {
    for (const raiseWindow of [
      async () => false,
      async () => {
        throw new Error("helper down");
      },
    ]) {
      const d = deps({ raiseWindow });
      expect(
        await resolveCapturePick({ kind: "window", windowId: 8 }, d),
      ).toEqual({ kind: "window", windowId: 8 });
    }
  });

  test("a helper that is slow to raise does not hold the pick", async () => {
    // A helper that never answers: the shared client would give up after a
    // minute, and a pick cannot wait that long on a window that is going
    // to be read where it is anyway.
    let late: ((raised: boolean) => void) | undefined;
    const d = deps({
      raiseWindow: () =>
        new Promise<boolean>((resolve) => {
          late = resolve;
        }),
    });
    const started = Date.now();
    await bringForward(8, d, 20);
    expect(Date.now() - started).toBeLessThan(1_000);
    // The answer arriving afterwards is taken quietly.
    late?.(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("a helper that fails after the wait does not surface an unhandled rejection", async () => {
    let fail: ((err: Error) => void) | undefined;
    const d = deps({
      raiseWindow: () =>
        new Promise<boolean>((_, reject) => {
          fail = reject;
        }),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      await bringForward(8, d, 20);
      fail?.(new Error("helper down"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a tab is shown, brought forward, and then is its window", async () => {
    const asked: (boolean | undefined)[] = [];
    const d = deps({
      listChromeTabs: async () => [
        { chromeWindowId: 101, tabIndex: 2, active: false, title: "Docs" },
      ],
      listWindows: async (includeOffscreen) => {
        asked.push(includeOffscreen);
        return [
          chrome({ windowId: 2, title: "Docs" }),
          chrome({ windowId: 3, title: "Inbox" }),
        ];
      },
    });
    expect(
      await resolveCapturePick(
        { kind: "tab", chromeWindowId: 101, tabIndex: 2 },
        d,
      ),
    ).toEqual({ kind: "window", windowId: 2 });
    expect(d.activated).toEqual([[101, 2]]);
    // Every window, so a look-alike on another Space is counted.
    expect(asked).toEqual([true]);
    // The window it resolved to, after Chrome's own activation, so the tab
    // is in front of the user's work and not only in front of Chrome's.
    expect(d.raised).toEqual([2]);
  });

  test("a tab Chrome no longer has resolves to nothing", async () => {
    const d = deps({ listChromeTabs: async () => [] });
    expect(
      await resolveCapturePick(
        { kind: "tab", chromeWindowId: 101, tabIndex: 2 },
        d,
      ),
    ).toBeNull();
    expect(d.activated).toEqual([]);
  });

  test("a tab whose window stays minimized resolves to nothing, not to another window", async () => {
    const d = deps({
      listChromeTabs: async () => [
        { chromeWindowId: 101, tabIndex: 2, active: false, title: "Docs" },
      ],
      activateChromeTab: async () => ({
        minimized: true,
        bounds: { x: 0, y: 0, width: 600, height: 400 },
      }),
      listWindows: async () => [chrome({ windowId: 2, title: "Docs" })],
    });
    expect(
      await resolveCapturePick(
        { kind: "tab", chromeWindowId: 101, tabIndex: 2 },
        d,
      ),
    ).toBeNull();
  });

  test("a helper that cannot list windows after the activation resolves to nothing", async () => {
    const d = deps({
      listChromeTabs: async () => [
        { chromeWindowId: 101, tabIndex: 2, active: false, title: "Docs" },
      ],
      listWindows: async () => {
        throw new Error("helper down");
      },
    });
    expect(
      await resolveCapturePick(
        { kind: "tab", chromeWindowId: 101, tabIndex: 2 },
        d,
      ),
    ).toBeNull();
  });

  test("a Chrome that will not show the tab resolves to nothing", async () => {
    const d = deps({
      listChromeTabs: async () => [
        { chromeWindowId: 101, tabIndex: 2, active: false, title: "Docs" },
      ],
      activateChromeTab: async () => {
        throw new Error("not permitted");
      },
    });
    expect(
      await resolveCapturePick(
        { kind: "tab", chromeWindowId: 101, tabIndex: 2 },
        d,
      ),
    ).toBeNull();
  });
});

describe("where a window is", () => {
  test("is its bounds while it is on screen, and nothing after", async () => {
    const d = deps({
      listWindows: async () => [
        window({ windowId: 7, bounds: { x: 1, y: 2, width: 3, height: 4 } }),
      ],
    });
    expect(await windowBoundsFor(7, d)).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
    expect(await windowBoundsFor(8, d)).toBeNull();
  });
});

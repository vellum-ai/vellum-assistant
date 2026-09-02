import { describe, expect, mock, test } from "bun:test";

const sent: unknown[] = [];
const popups: Array<{
  template: unknown;
  options: { x: number; y: number; window: unknown };
}> = [];

mock.module("electron", () => ({
  app: { isPackaged: true, name: "Vellum" },
  BrowserWindow: {
    getFocusedWindow: () => ({
      webContents: { send: (...args: unknown[]) => sent.push(args) },
    }),
    getAllWindows: () => [],
    fromWebContents: () => ({ isDestroyed: () => false }),
  },
  Menu: {
    buildFromTemplate: (template: unknown) => ({
      template,
      popup: (options: {
        x: number;
        y: number;
        window: unknown;
        callback: () => void;
      }) => {
        popups.push({ template, options });
        options.callback();
      },
    }),
    setApplicationMenu: () => undefined,
  },
  shell: { openExternal: () => Promise.resolve() },
}));

let featureFlags: Record<string, boolean> = {};
let onboardingActive = false;
let chromeDevTools = false;
mock.module("@vellumai/electron-desktop/settings", () => ({
  readSetting: () => featureFlags,
  onSettingChange: () => () => undefined,
}));
mock.module("@vellumai/electron-desktop/window-state", () => ({
  readOnboardingActive: () => onboardingActive,
}));
mock.module("@vellumai/electron-desktop/devtools", () => ({
  areChromeDevToolsEnabled: () => chromeDevTools,
}));
mock.module("./main-window", () => ({
  onOnboardingChange: () => () => undefined,
}));

const { buildWindowsMenu, installWindowsMenu } = await import("./menu");

type MenuOptions = Parameters<typeof buildWindowsMenu>[0];

const submenu = (
  label: string,
  options: MenuOptions = { openAbout: () => undefined },
): Array<Record<string, unknown>> => {
  const item = buildWindowsMenu(options).find((entry) => entry.label === label);
  return item?.submenu as Array<Record<string, unknown>>;
};

const enabled = (menu: string, label: string, options?: MenuOptions): unknown =>
  submenu(menu, options).find((item) => item.label === label)?.enabled;

describe("buildWindowsMenu", () => {
  test("uses Windows roles and disables unavailable providers", () => {
    expect(submenu("Window").some((item) => item.role === "close")).toBe(true);
    expect(enabled("Help", "Check for Updates...")).toBe(false);
    expect(enabled("File", "Install vellum Command...")).toBe(false);
    expect(enabled("Window", "Pop Out Conversation")).toBeUndefined();
  });

  test("gates Settings on onboarding and Developer on its flag", () => {
    expect(enabled("File", "Settings...")).toBe(true);
    expect(submenu("Developer")).toBeUndefined();
    expect(submenu("View").some((item) => item.role === "toggleDevTools")).toBe(
      false,
    );

    onboardingActive = true;
    featureFlags = { "developer-menu-items": true };
    chromeDevTools = true;
    try {
      expect(enabled("File", "Settings...")).toBe(false);
      expect(
        submenu("Developer").some((item) => item.label === "Replay Onboarding"),
      ).toBe(true);
      expect(
        submenu("View").some((item) => item.role === "toggleDevTools"),
      ).toBe(true);
    } finally {
      onboardingActive = false;
      featureFlags = {};
      chromeDevTools = false;
    }
  });

  test("enables update and CLI items when handlers are provided", () => {
    const options = {
      openAbout: () => undefined,
      checkForUpdates: () => undefined,
      installCli: () => undefined,
    };
    expect(enabled("Help", "Check for Updates...", options)).toBe(true);
    expect(enabled("File", "Install vellum Command...", options)).toBe(true);
  });

  test("dispatches committed commands to the focused window", () => {
    const item = submenu("File").find(
      (entry) => entry.label === "New Conversation",
    );
    (item?.click as (() => void) | undefined)?.();
    expect(sent).toEqual([["vellum:command", { kind: "newConversation" }]]);
  });
});

describe("installWindowsMenu", () => {
  type Handler = (args: unknown[], event: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  installWindowsMenu({
    handle: ((channel: string, _schema: unknown, fn: Handler) => {
      handlers.set(channel, fn);
    }) as never,
    openAbout: () => undefined,
  });

  test("reports the top-level menu ids and labels", () => {
    const titles = handlers.get("vellum:menu:titles")?.([], {});
    expect(titles).toEqual([
      { id: "file", label: "File" },
      { id: "edit", label: "Edit" },
      { id: "view", label: "View" },
      { id: "window", label: "Window" },
      { id: "help", label: "Help" },
    ]);
  });

  test("pops the requested submenu at zoom-scaled coordinates", async () => {
    await handlers.get("vellum:menu:popup")?.(["edit", 100, 44], {
      sender: { getZoomFactor: () => 1.25 },
    });
    expect(popups).toHaveLength(1);
    expect(popups[0]?.options.x).toBe(125);
    expect(popups[0]?.options.y).toBe(55);
    expect(popups[0]?.options.window).toBeDefined();
    const items = popups[0]?.template as Array<Record<string, unknown>>;
    expect(items.some((item) => item.role === "undo")).toBe(true);
  });

  test("ignores popups for unknown ids", async () => {
    await handlers.get("vellum:menu:popup")?.(["nope", 0, 0], {
      sender: { getZoomFactor: () => 1 },
    });
    expect(popups).toHaveLength(1);
  });
});

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

const { buildWindowsMenu, installWindowsMenu } = await import("./menu");

const submenu = (label: string): Array<Record<string, unknown>> => {
  const item = buildWindowsMenu({ openAbout: () => undefined }).find(
    (entry) => entry.label === label,
  );
  return item?.submenu as Array<Record<string, unknown>>;
};

const enabled = (menu: string, label: string): unknown =>
  submenu(menu).find((item) => item.label === label)?.enabled;

describe("buildWindowsMenu", () => {
  test("uses Windows roles and disables unavailable providers", () => {
    expect(submenu("Window").some((item) => item.role === "close")).toBe(true);
    expect(enabled("Help", "Check for Updates...")).toBe(false);
    expect(enabled("File", "Install vellum Command...")).toBe(false);
    expect(enabled("Window", "Pop Out Conversation")).toBe(false);
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

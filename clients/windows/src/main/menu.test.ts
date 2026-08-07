import { describe, expect, mock, test } from "bun:test";

const sent: unknown[] = [];

mock.module("electron", () => ({
  app: { isPackaged: true, name: "Vellum" },
  BrowserWindow: {
    getFocusedWindow: () => ({
      webContents: { send: (...args: unknown[]) => sent.push(args) },
    }),
    getAllWindows: () => [],
  },
  Menu: {
    buildFromTemplate: (template: unknown) => template,
    setApplicationMenu: () => undefined,
  },
  shell: { openExternal: () => Promise.resolve() },
}));

const { buildWindowsMenu } = await import("./menu");

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

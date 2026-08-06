import { describe, expect, mock, test } from "bun:test";

const sent: unknown[] = [];

mock.module("electron", () => ({
  app: { isPackaged: true, name: "Vellum" },
  BrowserWindow: {
    getFocusedWindow: () => ({ webContents: { send: (...args: unknown[]) => sent.push(args) } }),
    getAllWindows: () => [],
  },
  Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => undefined },
  shell: { openExternal: () => Promise.resolve() },
}));

const { buildWindowsMenu } = await import("./menu");

const submenu = (label: string): Array<Record<string, unknown>> => {
  const item = buildWindowsMenu({ openAbout: () => undefined }).find(
    (entry) => entry.label === label,
  );
  return item?.submenu as Array<Record<string, unknown>>;
};

describe("buildWindowsMenu", () => {
  test("uses Windows roles and disables unavailable providers", () => {
    expect(submenu("Window").some((item) => item.role === "close")).toBe(true);
    expect(submenu("Help").find((item) => item.label === "Check for Updates...")?.enabled).toBe(false);
    expect(submenu("File").find((item) => item.label === "Install vellum Command...")?.enabled).toBe(false);
  });

  test("dispatches committed commands to the focused window", () => {
    const item = submenu("File").find((entry) => entry.label === "New Conversation");
    (item?.click as (() => void) | undefined)?.();
    expect(sent).toEqual([["vellum:command", { kind: "newConversation" }]]);
  });
});

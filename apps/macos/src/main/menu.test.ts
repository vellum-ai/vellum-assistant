import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { CliPathInstallState } from "./cli-path-installer";

// ---------------------------------------------------------------------------
// Stubs and mocks (before importing ./menu)
// ---------------------------------------------------------------------------

type TemplateItem = {
  label?: string;
  role?: string;
  enabled?: boolean;
  click?: () => void | Promise<void>;
  submenu?: TemplateItem[];
};

const buildFromTemplateMock = mock((template: TemplateItem[]) => ({
  template,
  popup: () => undefined,
}));
const setApplicationMenuMock = mock((_menu: unknown) => undefined);

// Mutable so tests can flip packaged/dev; the CLI path items only exist in
// packaged builds, so packaged is the default here.
const electronApp = {
  name: "Vellum Electron",
  isPackaged: true,
};

mock.module("electron", () => ({
  app: electronApp,
  Menu: {
    buildFromTemplate: buildFromTemplateMock,
    setApplicationMenu: setApplicationMenuMock,
  },
  shell: {
    openExternal: mock(() => Promise.resolve()),
  },
}));

mock.module("./about", () => ({
  openAboutWindow: () => undefined,
}));

mock.module("./auto-update", () => ({
  checkForUpdates: () => undefined,
}));

mock.module("./commands", () => ({
  acceleratorOption: () => ({}),
  dispatchToFocused: () => undefined,
}));

mock.module("./command-palette-window", () => ({
  closeCommandPaletteWindow: () => undefined,
  isCommandPaletteWindowFocused: () => false,
  openCommandPaletteWindow: () => undefined,
}));

mock.module("./devtools", () => ({
  areChromeDevToolsEnabled: () => false,
}));

mock.module("./ipc", () => ({
  handle: () => undefined,
}));

mock.module("./main-window", () => ({
  dispatchToMain: () => undefined,
}));

// Full `./settings` surface so this mock — which leaks into co-run test files
// via the global module registry — doesn't break sibling modules.
mock.module("./settings", () => ({
  readSetting: () => null,
  readHotkeyOverride: () => null,
  writeSetting: () => {},
  onSettingChange: () => () => {},
}));

mock.module("./window-state", () => ({
  readOnboardingActive: () => false,
}));

const getCliPathInstallStateMock = mock(
  async (): Promise<CliPathInstallState> => ({ kind: "not-installed" }),
);
// Full `./cli-path-installer` surface so this mock — which leaks into co-run
// test files via the global module registry — doesn't break sibling modules.
mock.module("./cli-path-installer", () => ({
  WRAPPER_MARKER: "# vellum-cli-wrapper v1",
  getWrapperDir: () => "/tmp/.local/bin",
  getWrapperPath: () => "/tmp/.local/bin/vellum",
  buildWrapperScript: () => "",
  readWrapperOwnership: () => "absent",
  installWrapper: () => "installed",
  getCliPathInstallState: getCliPathInstallStateMock,
  uninstallWrapper: () => "absent",
}));

const callOrder: string[] = [];
const runInstallCliCommandFlowMock = mock(async () => {
  callOrder.push("install-flow");
});
const runUninstallCliCommandFlowMock = mock(async () => {
  callOrder.push("uninstall-flow");
});
mock.module("./cli-path-flow", () => ({
  runInstallCliCommandFlow: runInstallCliCommandFlowMock,
  runUninstallCliCommandFlow: runUninstallCliCommandFlowMock,
}));

const { installApplicationMenu, refreshCliPathMenuState } = await import(
  "./menu"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const lastTemplate = (): TemplateItem[] =>
  buildFromTemplateMock.mock.calls.at(-1)?.[0] ?? [];

const appSubmenu = (): TemplateItem[] => lastTemplate()[0]?.submenu ?? [];

const appMenuItem = (label: string): TemplateItem | undefined =>
  appSubmenu().find((item) => item.label === label);

const appMenuLabels = (): string[] =>
  appSubmenu()
    .map((item) => item.label)
    .filter((label): label is string => Boolean(label));

const setStateAndRefresh = async (state: CliPathInstallState) => {
  getCliPathInstallStateMock.mockResolvedValue(state);
  await refreshCliPathMenuState();
};

const INSTALL_LABEL = "Install vellum Command…";
const UNINSTALL_LABEL = "Uninstall vellum Command";
const SHADOWED_LABEL = "⚠ vellum is shadowed by another install";

installApplicationMenu();

beforeEach(async () => {
  electronApp.isPackaged = true;
  getCliPathInstallStateMock.mockReset();
  getCliPathInstallStateMock.mockResolvedValue({ kind: "not-installed" });
  // Settle any pending refresh kicked off by installApplicationMenu before
  // clearing call records, so tests observe only their own activity.
  await refreshCliPathMenuState();
  buildFromTemplateMock.mockClear();
  setApplicationMenuMock.mockClear();
  getCliPathInstallStateMock.mockClear();
  runInstallCliCommandFlowMock.mockClear();
  runUninstallCliCommandFlowMock.mockClear();
  callOrder.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CLI path menu items", () => {
  test("shows Install while detection state is unknown (null)", async () => {
    // Detection failure leaves the state null, the same shape the menu has
    // between startup and the first detection result.
    getCliPathInstallStateMock.mockRejectedValue(new Error("pending"));
    await refreshCliPathMenuState();
    expect(appMenuLabels()).toContain(INSTALL_LABEL);
    expect(appMenuLabels()).not.toContain(UNINSTALL_LABEL);
  });

  test("shows Install when not installed", async () => {
    await setStateAndRefresh({ kind: "not-installed" });
    expect(appMenuLabels()).toContain(INSTALL_LABEL);
    expect(appMenuLabels()).not.toContain(UNINSTALL_LABEL);
  });

  test("shows Install when a foreign file occupies the wrapper path", async () => {
    await setStateAndRefresh({ kind: "foreign-file" });
    expect(appMenuLabels()).toContain(INSTALL_LABEL);
    expect(appMenuLabels()).not.toContain(UNINSTALL_LABEL);
  });

  test("shows Uninstall when installed, without the shadowed indicator", async () => {
    await setStateAndRefresh({ kind: "installed", inPath: true });
    expect(appMenuLabels()).toContain(UNINSTALL_LABEL);
    expect(appMenuLabels()).not.toContain(INSTALL_LABEL);
    expect(appMenuLabels()).not.toContain(SHADOWED_LABEL);
  });

  test("shows Uninstall plus a disabled shadowed indicator when shadowed", async () => {
    await setStateAndRefresh({
      kind: "shadowed",
      shadowedBy: "/usr/local/bin/vellum",
    });
    expect(appMenuLabels()).toContain(UNINSTALL_LABEL);
    expect(appMenuLabels()).not.toContain(INSTALL_LABEL);
    expect(appMenuItem(SHADOWED_LABEL)?.enabled).toBe(false);
  });

  test("clicking Install runs the flow, then refreshes state and rebuilds", async () => {
    await setStateAndRefresh({ kind: "not-installed" });
    getCliPathInstallStateMock.mockClear();
    const buildsBefore = buildFromTemplateMock.mock.calls.length;

    getCliPathInstallStateMock.mockImplementation(async () => {
      callOrder.push("detect");
      return { kind: "installed", inPath: true };
    });
    await appMenuItem(INSTALL_LABEL)?.click?.();

    expect(runInstallCliCommandFlowMock).toHaveBeenCalledTimes(1);
    expect(getCliPathInstallStateMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["install-flow", "detect"]);
    // The rebuild reflects the new state: Install flipped to Uninstall.
    expect(buildFromTemplateMock.mock.calls.length).toBe(buildsBefore + 1);
    expect(appMenuLabels()).toContain(UNINSTALL_LABEL);
  });

  test("clicking Uninstall runs the flow, then refreshes state and rebuilds", async () => {
    await setStateAndRefresh({ kind: "installed", inPath: true });
    getCliPathInstallStateMock.mockClear();
    const buildsBefore = buildFromTemplateMock.mock.calls.length;

    getCliPathInstallStateMock.mockImplementation(async () => {
      callOrder.push("detect");
      return { kind: "not-installed" };
    });
    await appMenuItem(UNINSTALL_LABEL)?.click?.();

    expect(runUninstallCliCommandFlowMock).toHaveBeenCalledTimes(1);
    expect(getCliPathInstallStateMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["uninstall-flow", "detect"]);
    expect(buildFromTemplateMock.mock.calls.length).toBe(buildsBefore + 1);
    expect(appMenuLabels()).toContain(INSTALL_LABEL);
  });
});

describe("CLI path menu items in unpackaged builds", () => {
  test("shows neither item and never spawns detection", async () => {
    electronApp.isPackaged = false;
    await refreshCliPathMenuState();
    expect(getCliPathInstallStateMock).not.toHaveBeenCalled();
    expect(appMenuLabels()).not.toContain(INSTALL_LABEL);
    expect(appMenuLabels()).not.toContain(UNINSTALL_LABEL);
  });

  test("hides Uninstall even when a prior detection found an install", async () => {
    await setStateAndRefresh({ kind: "installed", inPath: true });
    expect(appMenuLabels()).toContain(UNINSTALL_LABEL);

    electronApp.isPackaged = false;
    getCliPathInstallStateMock.mockClear();
    await refreshCliPathMenuState();
    expect(getCliPathInstallStateMock).not.toHaveBeenCalled();
    expect(appMenuLabels()).not.toContain(INSTALL_LABEL);
    expect(appMenuLabels()).not.toContain(UNINSTALL_LABEL);
  });
});

describe("refreshCliPathMenuState", () => {
  test("rebuilds and reinstalls the application menu", async () => {
    await refreshCliPathMenuState();
    expect(buildFromTemplateMock).toHaveBeenCalledTimes(1);
    expect(setApplicationMenuMock).toHaveBeenCalledTimes(1);
  });

  test("a detection failure falls back to the Install item without throwing", async () => {
    getCliPathInstallStateMock.mockRejectedValue(new Error("boom"));
    await refreshCliPathMenuState();
    expect(appMenuLabels()).toContain(INSTALL_LABEL);
    expect(setApplicationMenuMock).toHaveBeenCalledTimes(1);
  });
});

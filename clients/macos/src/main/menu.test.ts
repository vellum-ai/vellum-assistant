import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { CliPathInstallState } from "./cli-path-installer";

// ---------------------------------------------------------------------------
// Stubs and mocks (before importing ./menu)
// ---------------------------------------------------------------------------

type TemplateItem = {
  label?: string;
  role?: string;
  type?: string;
  enabled?: boolean;
  accelerator?: string;
  checked?: boolean;
  // Optional argument so the no-arg call sites below still typecheck: Electron
  // passes the item, and only the checkbox items read it.
  click?: (item?: { checked: boolean }) => void | Promise<void>;
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

mock.module("./about.client", () => ({
  openAboutWindow: () => undefined,
}));

mock.module("./auto-update.client", () => ({
  checkForUpdates: () => undefined,
}));

mock.module("./commands.client", () => ({
  acceleratorOption: () => ({}),
  dispatchToFocused: () => undefined,
}));

mock.module("./command-palette.client", () => ({
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
mock.module("@vellumai/electron-desktop/settings", () => ({
  readSetting: () => null,
  writeSetting: () => {},
  onSettingChange: () => () => {},
}));

let companionHidden = false;
let companionHiddenListener: ((hidden: boolean) => void) | null = null;
mock.module("@vellumai/electron-desktop/window-state", () => ({
  readOnboardingActive: () => false,
  readCompanionHidden: () => companionHidden,
  onCompanionHiddenChange: (callback: (hidden: boolean) => void) => {
    companionHiddenListener = callback;
    return () => {
      companionHiddenListener = null;
    };
  },
}));

const setCompanionSurfaceVisibleMock = mock((_visible: boolean) => undefined);
mock.module("./companion-window", () => ({
  setCompanionSurfaceVisible: setCompanionSurfaceVisibleMock,
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
const isCliPathFlowInFlightMock = mock(() => false);
mock.module("./cli-path-flow", () => ({
  runInstallCliCommandFlow: runInstallCliCommandFlowMock,
  runUninstallCliCommandFlow: runUninstallCliCommandFlowMock,
  isCliPathFlowInFlight: isCliPathFlowInFlightMock,
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
const REPAIR_LABEL = "Repair vellum Command…";
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
  runInstallCliCommandFlowMock.mockReset();
  runInstallCliCommandFlowMock.mockImplementation(async () => {
    callOrder.push("install-flow");
  });
  runUninstallCliCommandFlowMock.mockReset();
  runUninstallCliCommandFlowMock.mockImplementation(async () => {
    callOrder.push("uninstall-flow");
  });
  isCliPathFlowInFlightMock.mockReset();
  isCliPathFlowInFlightMock.mockImplementation(() => false);
  callOrder.length = 0;
  companionHidden = false;
  setCompanionSurfaceVisibleMock.mockClear();
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
    await setStateAndRefresh({ kind: "installed", inPath: true, runtimeReady: true });
    expect(appMenuLabels()).toContain(UNINSTALL_LABEL);
    expect(appMenuLabels()).not.toContain(INSTALL_LABEL);
    expect(appMenuLabels()).not.toContain(REPAIR_LABEL);
    expect(appMenuLabels()).not.toContain(SHADOWED_LABEL);
  });

  test("shows Repair alongside Uninstall when the runtime is missing", async () => {
    await setStateAndRefresh({
      kind: "installed",
      inPath: true,
      runtimeReady: false,
    });
    expect(appMenuLabels()).toContain(REPAIR_LABEL);
    expect(appMenuLabels()).toContain(UNINSTALL_LABEL);
    expect(appMenuLabels()).not.toContain(INSTALL_LABEL);
  });

  test("shows Repair when shadowed with a missing runtime", async () => {
    await setStateAndRefresh({
      kind: "shadowed",
      shadowedBy: "/usr/local/bin/vellum",
      inPath: true,
      runtimeReady: false,
    });
    expect(appMenuLabels()).toContain(REPAIR_LABEL);
    expect(appMenuLabels()).toContain(UNINSTALL_LABEL);
  });

  test("clicking Repair runs the install flow, then Repair disappears once the runtime is ready", async () => {
    await setStateAndRefresh({
      kind: "installed",
      inPath: true,
      runtimeReady: false,
    });
    getCliPathInstallStateMock.mockResolvedValue({
      kind: "installed",
      inPath: true,
      runtimeReady: true,
    });

    await appMenuItem(REPAIR_LABEL)?.click?.();

    expect(runInstallCliCommandFlowMock).toHaveBeenCalledTimes(1);
    expect(appMenuLabels()).not.toContain(REPAIR_LABEL);
    expect(appMenuLabels()).toContain(UNINSTALL_LABEL);
  });

  test("shows Uninstall plus a disabled shadowed indicator when shadowed", async () => {
    await setStateAndRefresh({
      kind: "shadowed",
      shadowedBy: "/usr/local/bin/vellum",
      inPath: true,
      runtimeReady: true,
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
      return { kind: "installed", inPath: true, runtimeReady: true };
    });
    await appMenuItem(INSTALL_LABEL)?.click?.();

    expect(runInstallCliCommandFlowMock).toHaveBeenCalledTimes(1);
    expect(getCliPathInstallStateMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["install-flow", "detect"]);
    // Two rebuilds: the immediate in-flight render, then the final one
    // reflecting the new state: Install flipped to Uninstall.
    expect(buildFromTemplateMock.mock.calls.length).toBe(buildsBefore + 2);
    expect(appMenuLabels()).toContain(UNINSTALL_LABEL);
  });

  test("clicking Uninstall runs the flow, then refreshes state and rebuilds", async () => {
    await setStateAndRefresh({ kind: "installed", inPath: true, runtimeReady: true });
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
    expect(buildFromTemplateMock.mock.calls.length).toBe(buildsBefore + 2);
    expect(appMenuLabels()).toContain(INSTALL_LABEL);
  });

  test("renders the CLI path item disabled while a flow is in flight", async () => {
    isCliPathFlowInFlightMock.mockReturnValue(true);
    await setStateAndRefresh({ kind: "not-installed" });
    expect(appMenuItem(INSTALL_LABEL)?.enabled).toBe(false);
  });

  test("clicking Install immediately re-renders the item disabled, re-enabling after the flow", async () => {
    await setStateAndRefresh({ kind: "not-installed" });
    let release!: () => void;
    runInstallCliCommandFlowMock.mockImplementation(() => {
      isCliPathFlowInFlightMock.mockReturnValue(true);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const clicking = appMenuItem(INSTALL_LABEL)?.click?.();
    // The synchronous re-render shows the item disabled mid-flow.
    expect(appMenuItem(INSTALL_LABEL)?.enabled).toBe(false);

    isCliPathFlowInFlightMock.mockReturnValue(false);
    release();
    await clicking;
    expect(appMenuItem(INSTALL_LABEL)?.enabled).toBe(true);
  });
});

describe("app submenu separators", () => {
  const hasAdjacentSeparators = (items: TemplateItem[]): boolean =>
    items.some(
      (item, i) =>
        item.type === "separator" && items[i - 1]?.type === "separator",
    );

  test("no adjacent separators when CLI items are present", async () => {
    await setStateAndRefresh({ kind: "installed", inPath: true, runtimeReady: true });
    expect(hasAdjacentSeparators(appSubmenu())).toBe(false);
  });

  test("no adjacent separators when CLI items are hidden (dev build)", async () => {
    electronApp.isPackaged = false;
    await refreshCliPathMenuState();
    expect(appMenuLabels()).not.toContain(INSTALL_LABEL);
    expect(hasAdjacentSeparators(appSubmenu())).toBe(false);
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
    await setStateAndRefresh({ kind: "installed", inPath: true, runtimeReady: true });
    expect(appMenuLabels()).toContain(UNINSTALL_LABEL);

    electronApp.isPackaged = false;
    getCliPathInstallStateMock.mockClear();
    await refreshCliPathMenuState();
    expect(getCliPathInstallStateMock).not.toHaveBeenCalled();
    expect(appMenuLabels()).not.toContain(INSTALL_LABEL);
    expect(appMenuLabels()).not.toContain(UNINSTALL_LABEL);
  });
});

describe("View menu native fullscreen", () => {
  const viewSubmenu = (): TemplateItem[] =>
    lastTemplate().find((item) => item.label === "View")?.submenu ?? [];

  test("registers Toggle Full Screen with the macOS Control+Command+F equivalent", async () => {
    await refreshCliPathMenuState();
    const toggleFullscreen = viewSubmenu().find(
      (item) => item.role === "togglefullscreen",
    );
    expect(toggleFullscreen).toEqual({
      role: "togglefullscreen",
      accelerator: "Control+Command+F",
    });
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

describe("Window menu companion toggle", () => {
  const COMPANION_LABEL = "Show Companion";

  const windowSubmenu = (): TemplateItem[] =>
    lastTemplate().find((item) => item.label === "Window")?.submenu ?? [];

  const companionItem = (): TemplateItem | undefined =>
    windowSubmenu().find((item) => item.label === COMPANION_LABEL);

  test("offers the companion toggle as a checkbox in the Window menu", async () => {
    await refreshCliPathMenuState();
    expect(companionItem()?.type).toBe("checkbox");
  });

  test("checks the item while the surface is shown", async () => {
    companionHidden = false;
    await refreshCliPathMenuState();
    expect(companionItem()?.checked).toBe(true);
  });

  test("unchecks the item while the surface is hidden", async () => {
    companionHidden = true;
    await refreshCliPathMenuState();
    expect(companionItem()?.checked).toBe(false);
  });

  test("shows the surface when the item is ticked", async () => {
    companionHidden = true;
    await refreshCliPathMenuState();
    // Electron flips `checked` before `click`, so a tick arrives as `true`.
    await companionItem()?.click?.({ checked: true });
    expect(setCompanionSurfaceVisibleMock).toHaveBeenCalledWith(true);
  });

  test("hides the surface when the item is unticked", async () => {
    companionHidden = false;
    await refreshCliPathMenuState();
    await companionItem()?.click?.({ checked: false });
    expect(setCompanionSurfaceVisibleMock).toHaveBeenCalledWith(false);
  });

  test("rebuilds the menu when the surface is hidden from somewhere else", () => {
    // The tray item and the surface's own right-click "Hide" both move the
    // stored flag without going through this menu. Unlike the tray's, this
    // menu is built once and kept, so the subscription is the only thing that
    // brings its checkmark back in line.
    expect(companionHiddenListener).not.toBeNull();
    companionHidden = true;
    companionHiddenListener?.(true);
    expect(setApplicationMenuMock).toHaveBeenCalledTimes(1);
    expect(companionItem()?.checked).toBe(false);
  });
});

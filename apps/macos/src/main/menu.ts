import { Menu, type MenuItemConstructorOptions, app, shell } from "electron";
import { z } from "zod";

import { openAboutWindow } from "./about";
import { checkForUpdates } from "./auto-update";
import {
  isCliPathFlowInFlight,
  runInstallCliCommandFlow,
  runUninstallCliCommandFlow,
} from "./cli-path-flow";
import {
  type CliPathInstallState,
  getCliPathInstallState,
} from "./cli-path-installer";
import {
  acceleratorOption,
  dispatchToFocused,
  type VellumCommand,
} from "./commands";
import {
  closeCommandPaletteWindow,
  isCommandPaletteWindowFocused,
  openCommandPaletteWindow,
} from "./command-palette-window";
import { areChromeDevToolsEnabled } from "./devtools";
import { handle } from "./ipc";
import { dispatchToMain } from "./main-window";
import { onSettingChange, readSetting } from "./settings";
import { readOnboardingActive } from "./window-state";

interface MenuState {
  hasPlatformSession: boolean;
}

const state: MenuState = {
  hasPlatformSession: false,
};

// Null until the first detection completes; the menu shows the Install item
// in the meantime (the install flow is safe to run from any state).
let cliPathState: CliPathInstallState | null = null;

export const refreshCliPathMenuState = async (): Promise<void> => {
  if (app.isPackaged) {
    try {
      cliPathState = await getCliPathInstallState();
    } catch {
      cliPathState = null;
    }
  }
  applyMenu();
};

const cliPathFlowItem = (
  label: string,
  flow: () => Promise<void>,
): MenuItemConstructorOptions => ({
  label,
  enabled: !isCliPathFlowInFlight(),
  click: async () => {
    const flowDone = flow();
    // Re-render immediately so the item is disabled while the flow runs.
    applyMenu();
    await flowDone;
    await refreshCliPathMenuState();
  },
});

const cliPathItems = (): MenuItemConstructorOptions[] => {
  // Only packaged builds manage the shared ~/.local/bin/vellum wrapper.
  if (!app.isPackaged) return [];
  const cliState = cliPathState;
  if (cliState?.kind === "installed" || cliState?.kind === "shadowed") {
    return [
      ...(cliState.kind === "shadowed"
        ? [
            {
              label: "⚠ vellum is shadowed by another install",
              enabled: false,
            },
          ]
        : []),
      // Wrapper exists but the CLI runtime never provisioned; the install
      // flow is idempotent, so re-running it doubles as repair.
      ...(!cliState.runtimeReady
        ? [
            cliPathFlowItem(
              "Repair vellum Command\u2026",
              runInstallCliCommandFlow,
            ),
          ]
        : []),
      cliPathFlowItem("Uninstall vellum Command", runUninstallCliCommandFlow),
    ];
  }
  return [
    cliPathFlowItem("Install vellum Command\u2026", runInstallCliCommandFlow),
  ];
};

const isDeveloperMenuEnabled = (): boolean => {
  const flags = readSetting("featureFlags");
  return flags?.["developer-menu-items"] === true;
};

export const dispatchMenuCommand = (command: VellumCommand): void => {
  if (command.kind === "commandPalette") {
    if (isCommandPaletteWindowFocused()) {
      closeCommandPaletteWindow();
      return;
    }
    openCommandPaletteWindow();
    return;
  }
  if (isCommandPaletteWindowFocused()) {
    dispatchToMain(command);
    return;
  }
  dispatchToFocused(command);
};

const buildTemplate = (): MenuItemConstructorOptions[] => {
  const isDev = !app.isPackaged;
  const chromeDevToolsEnabled = areChromeDevToolsEnabled();
  const developerMenuEnabled = isDeveloperMenuEnabled();
  const cliItems = cliPathItems();

  const fileItem = (
    label: string,
    command: VellumCommand,
  ): MenuItemConstructorOptions => ({
    label,
    ...acceleratorOption(command.kind),
    click: () => dispatchMenuCommand(command),
  });

  return [
    {
      label: app.name,
      submenu: [
        {
          label: `About ${app.name}`,
          click: () => {
            openAboutWindow();
          },
        },
        ...(!isDev
          ? [
              {
                label: "Check for Updates\u2026",
                click: () => {
                  checkForUpdates();
                },
              },
            ]
          : []),
        { type: "separator" },
        {
          label: "Settings\u2026",
          ...acceleratorOption("openSettings"),
          enabled: !readOnboardingActive(),
          click: () => dispatchMenuCommand({ kind: "openSettings" }),
        },
        { type: "separator" },
        ...cliItems,
        ...(cliItems.length > 0 ? [{ type: "separator" as const }] : []),
        { role: "services" },
        { type: "separator" },
        {
          label: "Log Out",
          enabled: state.hasPlatformSession,
          click: () => dispatchMenuCommand({ kind: "logout" }),
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        fileItem("New Conversation", { kind: "newConversation" }),
        fileItem("Current Conversation", { kind: "currentConversation" }),
        { type: "separator" },
        fileItem("Mark Current as Unread", { kind: "markCurrentUnread" }),
        { type: "separator" },
        fileItem("Previous Conversation", { kind: "previousConversation" }),
        fileItem("Next Conversation", { kind: "nextConversation" }),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        {
          label: "Find\u2026",
          ...acceleratorOption("find"),
          click: () => dispatchMenuCommand({ kind: "find" }),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        fileItem("Toggle Sidebar", { kind: "sidebarToggle" }),
        fileItem("Home", { kind: "home" }),
        fileItem("Command Palette\u2026", { kind: "commandPalette" }),
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        ...(chromeDevToolsEnabled
          ? [{ role: "toggleDevTools" as const }]
          : []),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        fileItem("Pop Out Conversation", { kind: "popOut" }),
        { type: "separator" },
        { role: "front" },
      ],
    },
    ...(developerMenuEnabled
      ? [
          {
            label: "Developer",
            submenu: [
              {
                label: "Replay Onboarding",
                click: () => dispatchMenuCommand({ kind: "replayOnboarding" }),
              },
              {
                label: "Preview PreChat",
                click: () => dispatchMenuCommand({ kind: "previewPrechat" }),
              },
              {
                label: "Replay Hatch Failure",
                click: () => dispatchToFocused({ kind: "replayHatchFailure" }),
              },
              ...(!app.isPackaged
                ? [
                    { type: "separator" as const },
                    {
                      label: "Component Gallery",
                      click: () => {
                        void shell.openExternal("http://localhost:6007");
                      },
                    },
                  ]
                : []),
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      role: "help",
      submenu: [
        {
          label: "Send Feedback\u2026",
          click: () => dispatchMenuCommand({ kind: "shareFeedback" }),
        },
        { type: "separator" },
        {
          label: "Vellum Documentation",
          click: () => {
            void shell.openExternal("https://docs.vellum.ai");
          },
        },
      ],
    },
  ];
};

const applyMenu = (): void => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate()));
};

/**
 * Builds and installs the macOS application menu. Without this, Electron
 * ships a default menu that includes developer-flavored items (Reload,
 * Toggle Developer Tools at the top level) and lacks the standard macOS
 * shape end users expect.
 *
 * The `View > Toggle Developer Tools` item is gated to dev/debug builds so a
 * normal packaged build doesn't expose devtools to end users.
 *
 * Registers an IPC handler so the renderer can publish platform session
 * state, which gates the "Log Out" item in the app menu.
 */
let installed = false;
export const installApplicationMenu = (): void => {
  if (installed) return;
  installed = true;

  handle(
    "vellum:menu:setPlatformSession",
    z.tuple([z.boolean()]),
    ([has]) => {
      if (state.hasPlatformSession === has) return;
      state.hasPlatformSession = has;
      applyMenu();
    },
  );

  // Rebuild the menu when hotkey settings change so accelerators update
  // immediately without requiring an app restart.
  onSettingChange("hotkeys", () => {
    applyMenu();
  });

  // Rebuild the menu when feature flags change so the Developer submenu
  // appears or disappears without requiring an app restart.
  onSettingChange("featureFlags", () => {
    applyMenu();
  });

  applyMenu();

  // Detect the vellum CLI install state asynchronously so menu setup never
  // waits on (or breaks from) login-shell PATH resolution; packaged-only
  // gating lives inside refreshCliPathMenuState.
  void refreshCliPathMenuState();
};

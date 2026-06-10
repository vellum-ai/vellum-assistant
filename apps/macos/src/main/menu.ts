import { Menu, type MenuItemConstructorOptions, app, shell } from "electron";
import { z } from "zod";

import { openAboutWindow } from "./about";
import { checkForUpdates } from "./auto-update";
import {
  acceleratorOption,
  dispatchToFocused,
  type VellumCommand,
} from "./commands";
import { openCommandPaletteWindow } from "./command-palette-window";
import { areChromeDevToolsEnabled } from "./devtools";
import { handle } from "./ipc";
import { onSettingChange, readSetting } from "./settings";
import { readOnboardingActive } from "./window-state";

interface MenuState {
  hasPlatformSession: boolean;
}

const state: MenuState = {
  hasPlatformSession: false,
};

const isDeveloperMenuEnabled = (): boolean => {
  const flags = readSetting("featureFlags");
  return flags?.["developer-menu-items"] === true;
};

export const dispatchMenuCommand = (command: VellumCommand): void => {
  if (command.kind === "commandPalette") {
    openCommandPaletteWindow();
    return;
  }
  dispatchToFocused(command);
};

const buildTemplate = (): MenuItemConstructorOptions[] => {
  const isDev = !app.isPackaged;
  const chromeDevToolsEnabled = areChromeDevToolsEnabled();
  const developerMenuEnabled = isDeveloperMenuEnabled();

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
          click: () => dispatchToFocused({ kind: "openSettings" }),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        {
          label: "Log Out",
          enabled: state.hasPlatformSession,
          click: () => dispatchToFocused({ kind: "logout" }),
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
          click: () => dispatchToFocused({ kind: "find" }),
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
                click: () => dispatchToFocused({ kind: "replayOnboarding" }),
              },
              {
                label: "Preview PreChat",
                click: () => dispatchToFocused({ kind: "previewPrechat" }),
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
          click: () => dispatchToFocused({ kind: "shareFeedback" }),
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
};

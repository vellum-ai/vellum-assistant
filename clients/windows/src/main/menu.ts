import {
  BrowserWindow,
  Menu,
  app,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { z } from "zod";

import {
  acceleratorOption,
  dispatchToFocused,
  onHotkeyOverridesChange,
  type VellumCommand,
} from "@vellumai/electron-desktop/commands";
import { areChromeDevToolsEnabled } from "@vellumai/electron-desktop/devtools";
import type { IpcHandle } from "@vellumai/electron-desktop/ipc";
import {
  onSettingChange,
  readSetting,
} from "@vellumai/electron-desktop/settings";
import { readOnboardingActive } from "@vellumai/electron-desktop/window-state";
import {
  MENU_POPUP,
  MENU_SET_PLATFORM_SESSION,
  MENU_TITLES,
} from "@vellumai/ipc-contract";

import { onOnboardingChange } from "./main-window";

interface WindowsMenuOptions {
  handle: IpcHandle;
  openAbout: () => void;
  checkForUpdates?: () => void;
  installCli?: () => void;
}

let hasPlatformSession = false;

// Same flag the macOS menu reads; the renderer publishes it over IPC.
const isDeveloperMenuEnabled = (): boolean =>
  readSetting("featureFlags")?.["developer-menu-items"] === true;

const commandItem = (
  label: string,
  command: VellumCommand,
  enabled?: boolean,
): MenuItemConstructorOptions => ({
  label,
  ...acceleratorOption(command.kind),
  ...(enabled === undefined ? {} : { enabled }),
  click: () => dispatchToFocused(command),
});

export const buildWindowsMenu = ({
  openAbout,
  checkForUpdates,
  installCli,
}: Omit<WindowsMenuOptions, "handle">): MenuItemConstructorOptions[] => [
  {
    id: "file",
    label: "File",
    submenu: [
      commandItem("New Conversation", { kind: "newConversation" }),
      commandItem("Current Conversation", { kind: "currentConversation" }),
      { type: "separator" },
      commandItem("Pin Current Conversation", {
        kind: "togglePinConversation",
      }),
      commandItem("Mark Current as Unread", { kind: "markCurrentUnread" }),
      commandItem("Previous Conversation", { kind: "previousConversation" }),
      commandItem("Next Conversation", { kind: "nextConversation" }),
      { type: "separator" },
      commandItem(
        "Settings...",
        { kind: "openSettings" },
        !readOnboardingActive(),
      ),
      ...(app.isPackaged
        ? [
            {
              label: "Install vellum Command...",
              enabled: installCli !== undefined,
              click: installCli,
            },
          ]
        : []),
      { type: "separator" },
      hasPlatformSession
        ? commandItem("Log Out", { kind: "logout" })
        : commandItem("Log In", { kind: "login" }),
      { type: "separator" },
      { role: "quit" },
    ],
  },
  {
    id: "edit",
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
      commandItem("Find...", { kind: "find" }),
    ],
  },
  {
    id: "view",
    label: "View",
    submenu: [
      commandItem("Toggle Sidebar", { kind: "sidebarToggle" }),
      commandItem("Home", { kind: "home" }),
      commandItem("Command Palette...", { kind: "commandPalette" }),
      { type: "separator" },
      { role: "reload" },
      { role: "forceReload" },
      ...(areChromeDevToolsEnabled()
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
    id: "window",
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "close" },
      { type: "separator" },
      commandItem("Pop Out Conversation", { kind: "popOut" }),
    ],
  },
  ...(isDeveloperMenuEnabled()
    ? [
        {
          id: "developer",
          label: "Developer",
          submenu: [
            commandItem("Choose Assistant...", { kind: "chooseAssistant" }),
            commandItem("Replay Onboarding", { kind: "replayOnboarding" }),
            commandItem("Replay Hatch Failure", {
              kind: "replayHatchFailure",
            }),
          ],
        } satisfies MenuItemConstructorOptions,
      ]
    : []),
  {
    id: "help",
    label: "Help",
    submenu: [
      ...(app.isPackaged
        ? [
            {
              label: "Check for Updates...",
              enabled: checkForUpdates !== undefined,
              click: checkForUpdates,
            },
          ]
        : []),
      commandItem("Send Feedback...", { kind: "shareFeedback" }),
      {
        label: "Vellum Documentation",
        click: () => {
          void shell.openExternal("https://www.vellum.ai/docs");
        },
      },
      { type: "separator" },
      { label: `About ${app.name}`, click: openAbout },
    ],
  },
];

export const installWindowsMenu = (options: WindowsMenuOptions): void => {
  const apply = (): void => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildWindowsMenu(options)));
  };

  options.handle(
    MENU_SET_PLATFORM_SESSION,
    z.tuple([z.boolean()]),
    ([has]) => {
      if (hasPlatformSession !== has) {
        hasPlatformSession = has;
        apply();
      }
    },
  );
  // The main window hides the native frame (`titleBarStyle: "hidden"`), which
  // hides the OS menu bar with it. The renderer draws the top-level titles in
  // its title bar (localizing them by id) and pops the real native submenus
  // here, so items, accelerators, and enabled states keep the one template
  // above as owner.
  options.handle(MENU_TITLES, z.tuple([]), () =>
    buildWindowsMenu(options).map((item) => ({
      id: String(item.id),
      label: String(item.label),
    })),
  );
  options.handle(
    MENU_POPUP,
    z.tuple([z.string(), z.number(), z.number()]),
    ([id, x, y], event) => {
      const submenu = buildWindowsMenu(options).find(
        (item) => item.id === id,
      )?.submenu;
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!Array.isArray(submenu) || !win || win.isDestroyed()) {
        return;
      }
      // The renderer reports CSS pixels; popup() takes DIPs, which differ
      // from CSS pixels by the page zoom.
      const zoom = event.sender.getZoomFactor();
      return new Promise<void>((resolve) => {
        Menu.buildFromTemplate(submenu).popup({
          window: win,
          x: Math.round(x * zoom),
          y: Math.round(y * zoom),
          callback: resolve,
        });
      });
    },
  );
  onHotkeyOverridesChange(apply);
  onSettingChange("featureFlags", apply);
  onOnboardingChange(apply);
  apply();
};

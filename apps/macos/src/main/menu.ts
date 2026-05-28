import { Menu, type MenuItemConstructorOptions, app, shell } from "electron";

import {
  dispatchToFocused,
  resolveAccelerator,
  type VellumCommand,
} from "./commands";

/**
 * Builds and installs the macOS application menu. Without this, Electron
 * ships a default menu that includes developer-flavored items (Reload,
 * Toggle Developer Tools at the top level) and lacks the standard macOS
 * shape end users expect.
 *
 * The `View > Toggle Developer Tools` item is gated to dev only so the
 * packaged build doesn't expose devtools to end users.
 */
export const installApplicationMenu = (): void => {
  const isDev = !app.isPackaged;

  const fileItem = (
    label: string,
    command: VellumCommand,
  ): MenuItemConstructorOptions => ({
    label,
    accelerator: resolveAccelerator(command.kind),
    click: () => dispatchToFocused(command),
  });

  const template: MenuItemConstructorOptions[] = [
    {
      // macOS convention: the first submenu is always the app menu.
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
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
      ],
    },
    {
      role: "editMenu",
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        ...(isDev ? [{ role: "toggleDevTools" as const }] : []),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      role: "windowMenu",
    },
    {
      role: "help",
      submenu: [
        {
          label: "Vellum Documentation",
          click: () => {
            void shell.openExternal("https://docs.vellum.ai");
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

import { Menu, type MenuItemConstructorOptions, app, shell } from "electron";

/**
 * Builds and installs the macOS application menu. Without this, Electron
 * ships a default menu that includes developer-flavored items (Reload,
 * Toggle Developer Tools at the top level) and lacks the standard macOS
 * shape end users expect.
 *
 * Scope of this initial wiring:
 *
 * - `Vellum`, `Edit`, `View`, `Window`, `Help` — all entirely role-based,
 *   so the items work today without any renderer IPC.
 * - `File` items that need renderer-side actions (New Conversation, Mark
 *   Unread, etc.) are intentionally omitted here. They land in a future
 *   ticket alongside the renderer handlers that implement them. Adding
 *   menu items that do nothing when clicked is worse than omitting them
 *   from the menu entirely.
 *
 * The `View > Toggle Developer Tools` item is gated to dev only so the
 * packaged build doesn't expose devtools to end users.
 */
export const installApplicationMenu = (): void => {
  const isDev = !app.isPackaged;

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

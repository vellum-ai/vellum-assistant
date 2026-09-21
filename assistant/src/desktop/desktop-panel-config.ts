import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DESKTOP_CHROME_WINDOW_CLASS,
  desktopChromeArguments,
} from "./desktop-browser-endpoint.js";

const TERMINAL_WINDOW_CLASS = "vellum-desktop-terminal";
const TERMINAL_HEADER_CONFIG = "  window_decorations = 'TITLE|RESIZE',\n";

// Absolute icon paths work without an installed icon theme.
const TERMINAL_ICON_BASE64 = [
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAACBklEQVR42u2bP2vCQBjG/T",
  "QOQkDQQVopsQ6l4BD6CTI5dXLq5tJRCP0SDh0dumboKthv4CR0Cwidr3nkAhLa/DM5L3fP",
  "wQMiQd/n573vvYl3nQ4HB0eZMZ0+urGCWGGsKJa4siIZC2JymzTux9rjS8fjezEc3grHGW",
  "ohxIKYJBDE6NdpvB9rN5k8nL6o1+uLbtfRUogNMSJWxIzYLzXvYYqBrs7G/wIhZwTSw7vE",
  "vBiN7lpjPC3ELtPCqzLtozabT0GISqUD8gdTqO3mE8l02BWu9igibcr5IjVBFka/CIA9Kq",
  "kp5hPBE7wVaXKM+vXPZ4EsiG4WgMCk3P+nFgRZAEITp38qDcIsABFaS1MBwBs8ZgEQFgAQ",
  "BEAANQIYDG5EGH6K4/HnJLzGe9YAODefaLv90hJCIwDS5hMdDt9iNnuyF4COEJSlQBrCfP",
  "5sdhFEzmdBgBaLF3OXQUDYbD60h9B4H7Bev+dCwDVGN0I6Q1DWCWKq50FAyqjuFZS2wkUg",
  "qG6YlN8LYPnDMpgFAcuo0TdDaITyIBAAU4BFkMsgGyG2wrwZsvt2GJ+zXL6K1eotV7iuSv",
  "3Q+oFI3ufUsXxq/UisjPmqDZTWD0UxtcuYx/V8LM4/RvjXGAEQQM0ArN8gYf0WGes3Sdm9",
  "Tc76jZLcKsvN0twuzwMTPDLDQ1M8NseDkxwc9oxfPKEkIHDjoAYAAAAASUVORK5CYII=",
].join("");

export interface DesktopPanelConfigRequest {
  /** Runtime directory the config, launchers and icons are written to. */
  readonly configDir: string;
  /** Google Chrome, as resolved for the desktop's own browser. */
  readonly chromiumPath: string;
  /** Profile the launcher shares with that browser, so it reuses the window. */
  readonly chromiumProfileDir: string;
  readonly terminalPath: string;
  readonly fileManagerPath: string;
  readonly workspaceDir: string;
  readonly debugPort?: number;
}

/** Generate managed launchers and seed the desktop dock on first use. */
export function writeDesktopPanelConfig(
  request: DesktopPanelConfigRequest,
): void {
  const { configDir } = request;
  mkdirSync(configDir, { recursive: true });

  const terminalIcon = join(configDir, "terminal.png");
  const browserIcon = join(
    dirname(request.chromiumPath),
    "product_logo_64.png",
  );
  writeFileSync(terminalIcon, Buffer.from(TERMINAL_ICON_BASE64, "base64"));
  const terminalConfig = join(configDir, "wezterm", "wezterm.lua");
  mkdirSync(dirname(terminalConfig), { recursive: true });
  const terminalConfigContents = `local wezterm = require 'wezterm'
return {
  front_end = 'Software',
  enable_wayland = false,
  check_for_updates = false,
  hide_tab_bar_if_only_one_tab = false,
${TERMINAL_HEADER_CONFIG}  font_size = 11,
  color_scheme = 'Catppuccin Mocha',
  initial_cols = 110,
  initial_rows = 28,
  keys = {
    { key = 'd', mods = 'CTRL|SHIFT', action = wezterm.action.SplitHorizontal { domain = 'CurrentPaneDomain' } },
    { key = 'e', mods = 'CTRL|SHIFT', action = wezterm.action.SplitVertical { domain = 'CurrentPaneDomain' } },
  },
}
`;
  seedFile(terminalConfig, terminalConfigContents, [
    terminalConfigContents.replace(TERMINAL_HEADER_CONFIG, ""),
    ...["", "  integrated_title_buttons = { 'Maximize', 'Close' },\n"].map(
      (buttons) =>
        terminalConfigContents.replace(
          TERMINAL_HEADER_CONFIG,
          `  window_decorations = 'INTEGRATED_BUTTONS|RESIZE',\n  integrated_title_button_style = 'Gnome',\n${buttons}`,
        ),
    ),
  ]);

  const applicationsDir = join(configDir, "applications");
  mkdirSync(applicationsDir, { recursive: true });
  const chromiumEntry = join(applicationsDir, "google-chrome.desktop");
  // Saved dock pins reference this stable launcher path.
  const terminalEntry = join(applicationsDir, "xterm.desktop");
  const filesEntry = join(applicationsDir, "thunar.desktop");
  const minesEntry = join(applicationsDir, "org.gnome.Mines.desktop");
  writeFileSync(
    chromiumEntry,
    desktopEntry({
      name: "Google Chrome",
      windowClass: DESKTOP_CHROME_WINDOW_CLASS,
      icon: browserIcon,
      exec: desktopCommand([
        request.chromiumPath,
        ...desktopChromeArguments(
          request.chromiumProfileDir,
          request.debugPort,
        ),
      ]),
    }),
  );
  writeFileSync(
    terminalEntry,
    desktopEntry({
      name: "Terminal",
      windowClass: TERMINAL_WINDOW_CLASS,
      icon: terminalIcon,
      exec: desktopCommand([
        request.terminalPath,
        "start",
        "--new-tab",
        `--class=${TERMINAL_WINDOW_CLASS}`,
      ]),
    }),
  );

  writeFileSync(
    minesEntry,
    desktopEntry({
      name: "Mines",
      windowClass: "org.gnome.Mines",
      icon: "/usr/share/icons/hicolor/scalable/apps/org.gnome.Mines.svg",
      exec: "/usr/games/gnome-mines",
    }),
  );

  writeFileSync(
    filesEntry,
    desktopEntry({
      name: "Files",
      windowClass: "Thunar",
      icon: "/usr/share/icons/Adwaita/scalable/places/folder.svg",
      exec: desktopCommand([request.fileManagerPath, request.workspaceDir]),
    }),
  );

  const gtkDir = join(configDir, "gtk-3.0");
  const xfconfDir = join(configDir, "xfce4", "xfconf", "xfce-perchannel-xml");
  mkdirSync(gtkDir, { recursive: true });
  mkdirSync(xfconfDir, { recursive: true });
  seedFile(
    join(gtkDir, "settings.ini"),
    "[Settings]\ngtk-theme-name=Adwaita\ngtk-icon-theme-name=Adwaita\ngtk-application-prefer-dark-theme=true\ngtk-font-name=Sans 11\n",
  );
  seedFile(
    join(gtkDir, "bookmarks"),
    `${pathToFileURL(request.workspaceDir).href} Workspace\n`,
  );
  seedFile(
    join(xfconfDir, "thunar.xml"),
    `<channel name="thunar" version="1.0">
  <property name="last-window-width" type="int" value="1000"/>
  <property name="last-window-height" type="int" value="680"/>
  <property name="last-view" type="string" value="ThunarDetailsView"/>
</channel>\n`,
  );

  const launchersDir = join(configDir, "plank", "dock1", "launchers");
  const settingsDir = join(configDir, "glib-2.0", "settings");
  mkdirSync(launchersDir, { recursive: true });
  mkdirSync(settingsDir, { recursive: true });
  // The settings file completes initialization; pins can then be removed.
  if (existsSync(join(settingsDir, "keyfile"))) {
    return;
  }
  seedFile(join(launchersDir, "chrome.dockitem"), dockItem(chromiumEntry));
  seedFile(join(launchersDir, "files.dockitem"), dockItem(filesEntry));
  seedFile(join(launchersDir, "terminal.dockitem"), dockItem(terminalEntry));
  seedFile(join(launchersDir, "mines.dockitem"), dockItem(minesEntry));
  seedFile(
    join(settingsDir, "keyfile"),
    [
      "[net/launchpad/plank/docks/dock1]",
      "dock-items=['chrome.dockitem', 'files.dockitem', 'terminal.dockitem', 'mines.dockitem']",
      "icon-size=48",
      "hide-mode='none'",
      "theme='Matte'",
      "auto-pinning=false",
      "",
    ].join("\n"),
  );
}

function dockItem(launcher: string): string {
  return `[PlankDockItemPreferences]\nLauncher=${pathToFileURL(launcher).href}\n`;
}

function desktopCommand(args: string[]): string {
  return args
    .map((arg) => {
      const quoted = `"${arg.replace(/[\\"`$]/g, "\\$&").replace(/%/g, "%%")}"`;
      // Desktop values are unescaped before Exec arguments are parsed.
      return quoted
        .replace(/\\/g, "\\\\")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");
    })
    .join(" ");
}

export function seedFile(
  path: string,
  contents: string | Buffer,
  previousContents: readonly string[] = [],
): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, { flush: true });
    // Publish a complete file atomically without replacing user settings.
    linkSync(temporaryPath, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
    if (
      previousContents.length > 0 &&
      previousContents.includes(readFileSync(path, "utf8"))
    ) {
      renameSync(temporaryPath, path);
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function desktopEntry(entry: {
  name: string;
  windowClass: string;
  icon: string;
  exec: string;
}): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    `Name=${entry.name}`,
    `Icon=${entry.icon}`,
    `StartupWMClass=${entry.windowClass}`,
    `Exec=${entry.exec}`,
    "Terminal=false",
    "",
  ].join("\n");
}

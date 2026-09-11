import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

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

  const applicationsDir = join(configDir, "applications");
  mkdirSync(applicationsDir, { recursive: true });
  const chromiumEntry = join(applicationsDir, "google-chrome.desktop");
  const terminalEntry = join(applicationsDir, "xterm.desktop");
  const minesEntry = join(applicationsDir, "org.gnome.Mines.desktop");
  writeFileSync(
    chromiumEntry,
    desktopEntry({
      name: "Google Chrome",
      // Chrome includes its profile path in WM_CLASS.
      windowClass: `google-chrome (${request.chromiumProfileDir})`,
      icon: browserIcon,
      exec: `"${request.chromiumPath}" --no-sandbox --no-first-run --disable-dev-shm-usage "--user-data-dir=${request.chromiumProfileDir}"`,
    }),
  );
  writeFileSync(
    terminalEntry,
    desktopEntry({
      name: "Terminal",
      windowClass: "XTerm",
      icon: terminalIcon,
      // `-fa` picks a scalable font through fontconfig; xterm otherwise falls
      // back to the `fixed` bitmap, which is unreadable at this geometry.
      exec: `"${request.terminalPath}" -fa Monospace -fs 11 -bg '#1c1c22' -fg '#e6e6ea' -title Terminal`,
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

  const launchersDir = join(configDir, "plank", "dock1", "launchers");
  const settingsDir = join(configDir, "glib-2.0", "settings");
  mkdirSync(launchersDir, { recursive: true });
  mkdirSync(settingsDir, { recursive: true });
  // The settings file completes initialization; pins can then be removed.
  if (existsSync(join(settingsDir, "keyfile"))) {
    return;
  }
  seedFile(join(launchersDir, "chrome.dockitem"), dockItem(chromiumEntry));
  seedFile(join(launchersDir, "terminal.dockitem"), dockItem(terminalEntry));
  seedFile(join(launchersDir, "mines.dockitem"), dockItem(minesEntry));
  seedFile(
    join(settingsDir, "keyfile"),
    [
      "[net/launchpad/plank/docks/dock1]",
      "dock-items=['chrome.dockitem', 'terminal.dockitem', 'mines.dockitem']",
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

function seedFile(path: string, contents: string): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, { flush: true });
    // Publish a complete file atomically without replacing user settings.
    linkSync(temporaryPath, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function desktopEntry(entry: {
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

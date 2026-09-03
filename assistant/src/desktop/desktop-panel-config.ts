/**
 * The generated tint2 config behind the assistant desktop's dock: a
 * bottom-centered floating strip with icon-only launchers for Chromium and a
 * terminal, plus the window list. Generated at desktop start rather than baked
 * into the image because the Chromium launcher points at Playwright's
 * executable, whose path is only known at runtime.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Dock icons as 64px PNGs, written next to the config. The image ships no icon
 * theme, so a launcher whose `Icon=` is a theme name renders blank; an absolute
 * path to a file we wrote always resolves.
 */
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

const BROWSER_ICON_BASE64 = [
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAADHUlEQVR42u1bv2sUQRTOf6",
  "RgYSN4kCLYyFWpD/wDlEBAhAMDwSLNFRY2lqYVrOxytsHiIJVgkUbLsN5FY6KJk/2SHfky",
  "2Z2Z3X1r7pz34HHHzuzb9773a3Z3dmlJSUmpDvVfzHo5j3Ie55zlbG6Ys0IX6NTr0vBBzv",
  "u46Mrzmbn/bGrurs8HQxfoVAACHQeSht/OefJw89LoO2vfzK3H88nQDTpCV+gM3dsa30eI",
  "Ad15NrwMiCIikB79Nsab5eF0YQx3GboXadFvEvbZIhvvgJDVSgfkD0Jo0Y23XKTDJLrao4",
  "gsUs7H1ISiMA5iANhHJe1SodWtQ/Po5fcrjGNdXhM2wbaYRY6492Hcmw/H5tOXUxMizMFc",
  "aUBgU1EQez4ARlK5f+/p1Gy9/Wm+HpyZpoRzIQOyBGvByAfAWCL8h9tHQcPf7Z6YJ69/XD",
  "D+h4CATKE0GPsAyLC0bOP1j59/X1F+dvTnmoFlxuCYCxDOZYLsNtEA22CjDwDTFADkLCuM",
  "/6/eH18ozADgWJUMjDEAOBfHXLlN60MBgBEHwDUennqwcVlL8MsFLiSLCyXL4MhqCkInAL",
  "jGo4LzOHsf7S4kD3M4CngMstuAIA4AQpSNL8ttOx7jfTcKcK6vVmC8Tk0QB4DD0vU8GBXe",
  "EtpZrFzMtQQZ7jhHAnS4EQDYE1VKcPjX8RTmVqVBGfixLVIMACho+zzC0BYrl+2cOuHvpg",
  "FklI3jmja9MCcGYDEAOESr2hpX/7L0CDGHeRXA3DZjUkwMAPZ+FfKc/2V5HOKY87kIV0WK",
  "OABoPTGeZe9UedDHHEG+xRNHSqgtigAQe8GdvV9/5zVdulqCrLYOEQMgVJzcKt2kALrXCr",
  "W62GIrAkCoPdVVXgJEbredAsDh5stLBkoCgJBhXG98adkaAF6n46LuYy1mvgHyzfMx3xj5",
  "5jEAvvsNUQDmlRSAfwVAkimQfBFMvg3qQkiXwnozpLfD+kBEH4npQ1F9LK4vRvTVmL4c/W",
  "9fjye/QSL5LTLJb5JKe5tc8hsldausbpbW7fL6wYR+MqMfTelnc/rhpJJSOnQO/myK+l9m",
  "kncAAAAASUVORK5CYII=",
].join("");

export interface DesktopPanelConfigRequest {
  /** Runtime directory the config, launchers and icons are written to. */
  readonly configDir: string;
  /** Playwright's Chromium, as resolved for the desktop's own browser. */
  readonly chromiumPath: string;
  /** Profile the launcher shares with that browser, so it reuses the window. */
  readonly chromiumProfileDir: string;
  readonly terminalPath: string;
}

/**
 * Write the dock's tint2rc, its two `.desktop` launchers and their icons.
 * Returns the tint2rc path to hand `tint2 -c`.
 */
export function writeDesktopPanelConfig(
  request: DesktopPanelConfigRequest,
): string {
  const { configDir } = request;
  mkdirSync(configDir, { recursive: true });

  const terminalIcon = join(configDir, "terminal.png");
  const browserIcon = join(configDir, "browser.png");
  writeFileSync(terminalIcon, Buffer.from(TERMINAL_ICON_BASE64, "base64"));
  writeFileSync(browserIcon, Buffer.from(BROWSER_ICON_BASE64, "base64"));

  const chromiumEntry = join(configDir, "chromium.desktop");
  const terminalEntry = join(configDir, "terminal.desktop");
  writeFileSync(
    chromiumEntry,
    desktopEntry({
      name: "Chromium",
      icon: browserIcon,
      // The same profile as the desktop's own Chromium, so the launcher opens
      // a window in that instance instead of a second untracked browser.
      exec: `"${request.chromiumPath}" --no-sandbox --no-first-run --disable-dev-shm-usage "--user-data-dir=${request.chromiumProfileDir}"`,
    }),
  );
  writeFileSync(
    terminalEntry,
    desktopEntry({
      name: "Terminal",
      icon: terminalIcon,
      // `-fa` picks a scalable font through fontconfig; xterm otherwise falls
      // back to the `fixed` bitmap, which is unreadable at this geometry.
      exec: `"${request.terminalPath}" -fa Monospace -fs 11 -bg '#1c1c22' -fg '#e6e6ea' -title Terminal`,
    }),
  );

  const configPath = join(configDir, "tint2rc");
  writeFileSync(configPath, tint2rc([chromiumEntry, terminalEntry]));
  return configPath;
}

function desktopEntry(entry: {
  name: string;
  icon: string;
  exec: string;
}): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    `Name=${entry.name}`,
    `Icon=${entry.icon}`,
    `Exec=${entry.exec}`,
    "Terminal=false",
    "",
  ].join("\n");
}

/**
 * tint2 numbers backgrounds by the order their `rounded` lines appear, so the
 * three below become ids 1 (the dock), 2 (an idle icon) and 3 (an active one).
 * Every key here is a documented tint2 option: it ignores unknown ones in
 * silence, which would quietly hand back the stock panel look.
 */
function tint2rc(launchers: readonly string[]): string {
  return [
    "# Generated by the Vellum assistant desktop. Edits are overwritten.",
    "",
    "#---- Backgrounds",
    "# 1: the dock itself",
    "rounded = 18",
    "border_width = 1",
    "border_sides = TBLR",
    "background_color = #101014 62",
    "border_color = #ffffff 16",
    "",
    "# 2: an idle launcher icon or window button",
    "rounded = 12",
    "border_width = 0",
    "border_sides = TBLR",
    "background_color = #ffffff 0",
    "border_color = #ffffff 0",
    "background_color_hover = #ffffff 16",
    "",
    "# 3: the active window button",
    "rounded = 12",
    "border_width = 0",
    "border_sides = TBLR",
    "background_color = #ffffff 20",
    "border_color = #ffffff 0",
    "background_color_hover = #ffffff 26",
    "",
    "#---- Panel",
    "panel_items = LT",
    "panel_monitor = all",
    "panel_position = bottom center horizontal",
    // panel_shrink pulls the panel in to fit its contents, so the declared
    // width is only a ceiling and the dock floats instead of spanning.
    "panel_size = 100% 62",
    "panel_shrink = 1",
    "panel_margin = 0 14",
    "panel_padding = 10 5 10",
    "panel_background_id = 1",
    "panel_layer = top",
    "panel_dock = 0",
    "wm_menu = 0",
    "autohide = 0",
    "strut_policy = follow_size",
    "",
    "#---- Launcher",
    ...launchers.map((path) => `launcher_item_app = ${path}`),
    "launcher_icon_size = 44",
    "launcher_padding = 2 0 8",
    "launcher_background_id = 0",
    "launcher_icon_background_id = 2",
    "launcher_icon_asb = 100 0 0",
    "launcher_tooltip = 1",
    "startup_notifications = 0",
    "",
    "#---- Taskbar",
    "taskbar_mode = single_desktop",
    "taskbar_padding = 2 0 8",
    "taskbar_background_id = 0",
    "taskbar_hide_if_empty = 1",
    "task_align = center",
    "task_text = 0",
    "task_icon = 1",
    "task_centered = 1",
    // Window buttons match the launcher icons, padding included, so the two
    // halves of the dock line up.
    "task_maximum_size = 44 44",
    "task_padding = 4 4 0",
    "task_background_id = 2",
    "task_active_background_id = 3",
    "task_icon_asb = 100 0 0",
    "mouse_left = toggle_iconify",
    "",
  ].join("\n");
}

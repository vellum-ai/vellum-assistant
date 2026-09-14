import * as fs from "node:fs";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";

import { writeDesktopPanelConfig } from "./desktop-panel-config.js";

const workspaces: string[] = [];

afterEach(() => {
  for (const dir of workspaces.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("initializes the dock and preserves user changes across restarts", () => {
  const workspace = mkdtempSync(join(tmpdir(), "desktop-dock-"));
  workspaces.push(workspace);
  const configDir = join(workspace, "data", "desktop-panel");
  const profileDir = join(workspace, "data", "desktop-profile");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "Preferences"), "browser preferences");
  writeFileSync(join(configDir, "wallpaper.png"), "keep");
  const request = {
    configDir,
    chromiumPath: "/opt/chrome-v1/chrome",
    chromiumProfileDir: profileDir,
    terminalPath: "/usr/bin/xterm",
  };
  writeDesktopPanelConfig(request);
  const settingsPath = join(configDir, "glib-2.0", "settings", "keyfile");
  const pinsDir = join(configDir, "plank", "dock1", "launchers");
  const settings = readFileSync(settingsPath, "utf8");
  expect(settings.length).toBeGreaterThan(0);
  expect(
    readFileSync(join(pinsDir, "chrome.dockitem"), "utf8"),
  ).not.toBeEmpty();

  expect(readFileSync(join(pinsDir, "mines.dockitem"), "utf8")).toContain(
    "applications/org.gnome.Mines.desktop",
  );
  expect(
    readFileSync(
      join(configDir, "applications", "org.gnome.Mines.desktop"),
      "utf8",
    ),
  ).toContain("Exec=/usr/games/gnome-mines");

  // Removed pins stay removed across restarts.
  rmSync(join(pinsDir, "chrome.dockitem"));
  rmSync(join(pinsDir, "mines.dockitem"));
  const customSettings = settings.replace("icon-size=48", "icon-size=64");
  writeFileSync(settingsPath, customSettings);
  writeDesktopPanelConfig({
    ...request,
    chromiumPath: "/opt/chrome-v2/chrome",
  });
  expect(() => readFileSync(join(pinsDir, "chrome.dockitem"))).toThrow();
  expect(() => readFileSync(join(pinsDir, "mines.dockitem"))).toThrow();
  expect(readFileSync(settingsPath, "utf8")).toBe(customSettings);
  expect(
    readFileSync(
      join(configDir, "applications", "google-chrome.desktop"),
      "utf8",
    ),
  ).toContain("/opt/chrome-v2/chrome");
  expect(readFileSync(join(profileDir, "Preferences"), "utf8")).toBe(
    "browser preferences",
  );
  expect(readFileSync(join(configDir, "wallpaper.png"), "utf8")).toBe("keep");
});

test("initialization recovers partial pin creation", () => {
  const workspace = mkdtempSync(join(tmpdir(), "desktop-dock-"));
  workspaces.push(workspace);
  const configDir = join(workspace, "data", "desktop-panel");
  const pinsDir = join(configDir, "plank", "dock1", "launchers");
  mkdirSync(pinsDir, { recursive: true });
  writeFileSync(join(pinsDir, "chrome.dockitem"), "existing pin");
  writeDesktopPanelConfig({
    configDir,
    chromiumPath: "/opt/chrome/chrome",
    chromiumProfileDir: join(workspace, "data", "desktop-profile"),
    terminalPath: "/usr/bin/xterm",
  });
  expect(readFileSync(join(pinsDir, "chrome.dockitem"), "utf8")).toBe(
    "existing pin",
  );
  expect(
    readFileSync(join(pinsDir, "terminal.dockitem"), "utf8"),
  ).not.toBeEmpty();
  expect(
    readFileSync(join(configDir, "glib-2.0", "settings", "keyfile"), "utf8"),
  ).not.toBeEmpty();
});

test("a failed settings write leaves initialization retryable", () => {
  const workspace = mkdtempSync(join(tmpdir(), "desktop-dock-"));
  workspaces.push(workspace);
  const configDir = join(workspace, "data", "desktop-panel");
  const settingsPath = join(configDir, "glib-2.0", "settings", "keyfile");
  const request = {
    configDir,
    chromiumPath: "/opt/chrome/chrome",
    chromiumProfileDir: join(workspace, "data", "desktop-profile"),
    terminalPath: "/usr/bin/xterm",
  };
  const write = fs.writeFileSync;
  const interrupted = spyOn(fs, "writeFileSync").mockImplementation(
    (...args) => {
      if (String(args[0]).startsWith(`${settingsPath}.`)) {
        write(args[0], "partial settings");
        throw new Error("interrupted write");
      }
      write(...args);
    },
  );
  try {
    expect(() => writeDesktopPanelConfig(request)).toThrow("interrupted write");
  } finally {
    interrupted.mockRestore();
  }
  expect(fs.existsSync(settingsPath)).toBe(false);
  writeDesktopPanelConfig(request);
  expect(readFileSync(settingsPath, "utf8")).not.toContain("partial settings");
  expect(readFileSync(settingsPath, "utf8")).not.toBeEmpty();
});

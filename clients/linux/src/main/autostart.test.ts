import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const warnings: string[] = [];
const errors: string[] = [];

mock.module("./logger", () => ({
  default: {
    info: () => undefined,
    warn: (message: string) => {
      warnings.push(message);
    },
    error: (message: string) => {
      errors.push(message);
    },
  },
  getLogFilePaths: () => [],
}));

const { autostartEntryPath, autostartLoginItemBackend } =
  await import("./autostart");

let configHome = "";
const originalXdg = process.env.XDG_CONFIG_HOME;
const originalEnvironment = process.env.VELLUM_ENVIRONMENT;
const originalAppImage = process.env.APPIMAGE;

const restore = (key: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

beforeEach(() => {
  warnings.length = 0;
  errors.length = 0;
  configHome = join(
    tmpdir(),
    `vellum-autostart-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(configHome, { recursive: true });
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.VELLUM_ENVIRONMENT = "production";
  delete process.env.APPIMAGE;
});

afterEach(() => {
  rmSync(configHome, { force: true, recursive: true });
  restore("XDG_CONFIG_HOME", originalXdg);
  restore("VELLUM_ENVIRONMENT", originalEnvironment);
  restore("APPIMAGE", originalAppImage);
});

describe("autostartLoginItemBackend", () => {
  test("enabling writes a desktop entry that launches the AppImage hidden", () => {
    process.env.APPIMAGE = "/home/user/Apps/Vellum.AppImage";

    expect(autostartLoginItemBackend.read()).toBe(false);
    autostartLoginItemBackend.write(true);

    const path = join(
      configHome,
      "autostart",
      "com.vellum.vellum-assistant-electron.desktop",
    );
    expect(autostartEntryPath()).toBe(path);
    const entry = readFileSync(path, "utf8");
    expect(entry).toContain('Exec="/home/user/Apps/Vellum.AppImage" --hidden');
    expect(entry).toContain("Hidden=false");
    expect(entry).toContain("X-GNOME-Autostart-enabled=true");
    expect(autostartLoginItemBackend.read()).toBe(true);
  });

  test("disabling removes the entry it wrote", () => {
    autostartLoginItemBackend.write(true);
    autostartLoginItemBackend.write(false);

    expect(existsSync(autostartEntryPath())).toBe(false);
    expect(autostartLoginItemBackend.read()).toBe(false);
  });

  test("reports a Hidden entry as disabled", () => {
    autostartLoginItemBackend.write(true);
    const path = autostartEntryPath();
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("Hidden=false", "Hidden=true"),
    );

    expect(autostartLoginItemBackend.read()).toBe(false);
  });

  test("leaves an entry written by someone else untouched", () => {
    const path = autostartEntryPath();
    mkdirSync(join(configHome, "autostart"), { recursive: true });
    const foreign = "[Desktop Entry]\nType=Application\nExec=/usr/bin/vellum\n";
    writeFileSync(path, foreign);

    expect(autostartLoginItemBackend.write(false)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(foreign);

    expect(autostartLoginItemBackend.write(true)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(foreign);
    expect(warnings).toHaveLength(2);
  });

  test("logs instead of throwing when the autostart directory cannot be created", () => {
    // A regular file where the autostart directory belongs makes mkdir fail
    // regardless of the running user.
    writeFileSync(join(configHome, "autostart"), "not a directory");

    expect(autostartLoginItemBackend.write(true)).toBe(false);
    expect(errors).toHaveLength(1);
    expect(autostartLoginItemBackend.read()).toBe(false);
  });
});

test("respects a GNOME-disabled entry", () => {
  autostartLoginItemBackend.write(true);
  const path = autostartEntryPath();
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      "X-GNOME-Autostart-enabled=true",
      "X-GNOME-Autostart-enabled=false",
    ),
  );
  expect(autostartLoginItemBackend.read()).toBe(false);
});

test("rejects paths that could introduce another desktop-entry field", () => {
  process.env.APPIMAGE = "/opt/Vellum\nExec=other.AppImage";
  expect(autostartLoginItemBackend.write(true)).toBe(false);
  expect(existsSync(autostartEntryPath())).toBe(false);
});

test("escapes Exec metacharacters without introducing arguments or field codes", () => {
  process.env.APPIMAGE = '/opt/Apps/Vellum "test" $value %U.AppImage';
  expect(autostartLoginItemBackend.write(true)).toBe(true);
  const entry = readFileSync(autostartEntryPath(), "utf8");
  expect(entry).toContain('%%U.AppImage" --hidden');
  expect(entry).toContain(String.raw`\\"test\\" \\$value`);
  expect(
    entry.split("\n").filter((line) => line.startsWith("Exec=")),
  ).toHaveLength(1);
});

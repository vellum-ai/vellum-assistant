import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ExecFileFn, LinuxEnvironmentIo } from "./linux-environment";

mock.module("./logger", () => ({
  default: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
  getLogFilePaths: () => [],
}));

// Imported after the logger mock: ./logger pulls in electron-log, whose
// initialize() needs a real Electron app.
const { __resetForTesting, readLinuxEnvironment, sessionBusNameHasOwner } =
  await import("./linux-environment");

const OS_RELEASE = [
  "# a comment",
  "",
  'NAME="Ubuntu"',
  'PRETTY_NAME="Ubuntu 24.04.1 LTS"',
  "ID=ubuntu",
  'VERSION_ID="24.04"',
].join("\n");

function io(overrides: Partial<LinuxEnvironmentIo> = {}): LinuxEnvironmentIo {
  return {
    readTextFile: () => OS_RELEASE,
    isWritable: () => true,
    ...overrides,
  };
}

function execStub(result: { error?: Error; stdout?: string }): {
  exec: ExecFileFn;
  calls: { file: string; args: string[] }[];
} {
  const calls: { file: string; args: string[] }[] = [];
  const exec: ExecFileFn = (file, args, _options, callback) => {
    calls.push({ file, args });
    queueMicrotask(() =>
      callback(result.error ?? null, result.stdout ?? "", ""),
    );
  };
  return { exec, calls };
}

describe("readLinuxEnvironment", () => {
  beforeEach(() => {
    __resetForTesting();
  });

  test("reads a declared Wayland session, desktop list and distro", () => {
    const env = readLinuxEnvironment(
      {
        XDG_SESSION_TYPE: "wayland",
        WAYLAND_DISPLAY: "wayland-0",
        DISPLAY: ":0",
        XDG_CURRENT_DESKTOP: "ubuntu:GNOME",
      },
      io(),
    );

    expect(env.sessionType).toBe("wayland");
    expect(env.desktop).toEqual(["ubuntu", "gnome"]);
    expect(env.distro).toEqual({
      id: "ubuntu",
      versionId: "24.04",
      prettyName: "Ubuntu 24.04.1 LTS",
    });
    expect(env.appImagePath).toBeNull();
    expect(env.appImageWritable).toBeNull();
  });

  test("XDG_SESSION_TYPE wins over the display sockets", () => {
    const env = readLinuxEnvironment(
      { XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-0" },
      io(),
    );

    expect(env.sessionType).toBe("x11");
  });

  test("falls back to WAYLAND_DISPLAY then DISPLAY for a tty session type", () => {
    expect(
      readLinuxEnvironment(
        {
          XDG_SESSION_TYPE: "tty",
          WAYLAND_DISPLAY: "wayland-0",
          DISPLAY: ":0",
        },
        io(),
      ).sessionType,
    ).toBe("wayland");

    __resetForTesting();
    expect(readLinuxEnvironment({ DISPLAY: ":0" }, io()).sessionType).toBe(
      "x11",
    );
  });

  test("reports an unknown session with no desktop when nothing is set", () => {
    const env = readLinuxEnvironment({}, io());

    expect(env.sessionType).toBe("unknown");
    expect(env.desktop).toEqual([]);
  });

  test("returns a null distro when /etc/os-release is missing", () => {
    const paths: string[] = [];
    const env = readLinuxEnvironment(
      {},
      io({
        readTextFile: (filePath) => {
          paths.push(filePath);
          return null;
        },
      }),
    );

    expect(paths).toEqual(["/etc/os-release"]);
    expect(env.distro).toBeNull();
  });

  test("returns a null distro when os-release carries none of the fields", () => {
    const env = readLinuxEnvironment(
      {},
      io({ readTextFile: () => 'HOME_URL="https://example.com"\n' }),
    );

    expect(env.distro).toBeNull();
  });

  test("keeps unset os-release fields null and unescapes quoted values", () => {
    const env = readLinuxEnvironment(
      {},
      io({
        readTextFile: () => 'PRETTY_NAME="Alpine \\"edge\\""\nID=alpine\n',
      }),
    );

    expect(env.distro).toEqual({
      id: "alpine",
      versionId: null,
      prettyName: 'Alpine "edge"',
    });
  });

  test("reports AppImage writability from the probed path", () => {
    const probed: string[] = [];
    const env = readLinuxEnvironment(
      { APPIMAGE: "/opt/Vellum.AppImage" },
      io({
        isWritable: (filePath) => {
          probed.push(filePath);
          return false;
        },
      }),
    );

    expect(env.appImagePath).toBe("/opt/Vellum.AppImage");
    expect(env.appImageWritable).toBe(false);
    expect(probed).toEqual(["/opt/Vellum.AppImage"]);
  });

  test("memoizes the first probe and re-reads after a reset", () => {
    let reads = 0;
    const counting = io({
      readTextFile: () => {
        reads += 1;
        return OS_RELEASE;
      },
    });

    const first = readLinuxEnvironment({ XDG_SESSION_TYPE: "x11" }, counting);
    const second = readLinuxEnvironment(
      { XDG_SESSION_TYPE: "wayland" },
      counting,
    );

    expect(second).toBe(first);
    expect(second.sessionType).toBe("x11");
    expect(reads).toBe(1);

    __resetForTesting();
    expect(
      readLinuxEnvironment({ XDG_SESSION_TYPE: "wayland" }, counting)
        .sessionType,
    ).toBe("wayland");
    expect(reads).toBe(2);
  });
});

describe("sessionBusNameHasOwner", () => {
  test("asks dbus-send on the session bus and reads a true reply", async () => {
    const { exec, calls } = execStub({
      stdout:
        "method return time=1756944000.1 sender=org.freedesktop.DBus -> destination=:1.42\n   boolean true\n",
    });

    await expect(
      sessionBusNameHasOwner("org.freedesktop.portal.Desktop", exec),
    ).resolves.toBe(true);
    expect(calls).toEqual([
      {
        file: "dbus-send",
        args: [
          "--session",
          "--print-reply",
          "--dest=org.freedesktop.DBus",
          "/org/freedesktop/DBus",
          "org.freedesktop.DBus.NameHasOwner",
          "string:org.freedesktop.portal.Desktop",
        ],
      },
    ]);
  });

  test("reads a false reply", async () => {
    const { exec } = execStub({ stdout: "   boolean false\n" });

    await expect(
      sessionBusNameHasOwner("org.example.Absent", exec),
    ).resolves.toBe(false);
  });

  test("returns null when dbus-send is missing", async () => {
    const { exec } = execStub({
      error: Object.assign(new Error("spawn dbus-send ENOENT"), {
        code: "ENOENT",
      }),
    });

    await expect(
      sessionBusNameHasOwner("org.freedesktop.portal.Desktop", exec),
    ).resolves.toBeNull();
  });

  test("returns null when the reply carries no boolean", async () => {
    const { exec } = execStub({ stdout: "method return time=1\n" });

    await expect(
      sessionBusNameHasOwner("org.example.Odd", exec),
    ).resolves.toBeNull();
  });
});

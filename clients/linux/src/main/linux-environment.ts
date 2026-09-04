import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";

import log from "./logger";

// os-release precedence per the freedesktop spec: /etc wins, /usr/lib is
// the fallback on distros that ship no /etc copy.
const OS_RELEASE_PATHS = ["/etc/os-release", "/usr/lib/os-release"];
const DBUS_SEND_TIMEOUT_MS = 2_000;

/** How the current graphical session talks to its display server. */
export type LinuxSessionType = "x11" | "wayland" | "unknown";

export interface LinuxDistro {
  /** `ID` from os-release, e.g. `ubuntu`. */
  id: string | null;
  /** `VERSION_ID` from os-release, e.g. `24.04`. */
  versionId: string | null;
  /** `PRETTY_NAME` from os-release, e.g. `Ubuntu 24.04.1 LTS`. */
  prettyName: string | null;
}

export interface LinuxEnvironment {
  sessionType: LinuxSessionType;
  /** `XDG_CURRENT_DESKTOP` entries, lowercased, e.g. `["ubuntu", "gnome"]`. */
  desktop: string[];
  /** null when os-release is missing or carries none of the fields. */
  distro: LinuxDistro | null;
  /** Absolute path of the running AppImage, or null outside one. */
  appImagePath: string | null;
  /** null when not running from an AppImage. */
  appImageWritable: boolean | null;
}

export interface LinuxEnvironmentIo {
  /** File contents, or null when unreadable. */
  readTextFile: (filePath: string) => string | null;
  isWritable: (filePath: string) => boolean;
}

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

const defaultIo: LinuxEnvironmentIo = {
  readTextFile: (filePath) => {
    try {
      return readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  },
  isWritable: (filePath) => {
    try {
      accessSync(filePath, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

let cached: LinuxEnvironment | null = null;

/**
 * Probe the session once and reuse the result. Every value comes from the
 * injected env and io, and anything the session does not state is `null` or
 * `"unknown"` rather than guessed.
 */
export function readLinuxEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  io: LinuxEnvironmentIo = defaultIo,
): LinuxEnvironment {
  if (cached) {
    return cached;
  }

  const appImagePath = nonEmpty(env.APPIMAGE);
  cached = {
    sessionType: readSessionType(env),
    desktop: readDesktop(env),
    distro: readDistro(io),
    appImagePath,
    appImageWritable:
      appImagePath === null ? null : io.isWritable(appImagePath),
  };

  log.info("[linux-environment] probed session:", cached);

  return cached;
}

/** Reset the memoized probe. Exposed for testing only. */
export function __resetForTesting(): void {
  cached = null;
}

/**
 * Whether `name` is currently owned on the session bus: `true`, `false`, or
 * `null` when the answer is unknown (no `dbus-send`, no session bus, timeout).
 */
export function sessionBusNameHasOwner(
  name: string,
  exec: ExecFileFn = execFile as unknown as ExecFileFn,
): Promise<boolean | null> {
  return new Promise((resolve) => {
    exec(
      "dbus-send",
      [
        "--session",
        "--print-reply",
        "--dest=org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus.NameHasOwner",
        `string:${name}`,
      ],
      { timeout: DBUS_SEND_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          log.info(`[linux-environment] dbus-send ${name} failed:`, error);
          resolve(null);
          return;
        }
        resolve(parseBooleanReply(stdout));
      },
    );
  });
}

// `boolean true` / `boolean false` on the reply's value line.
function parseBooleanReply(stdout: string): boolean | null {
  const match = /\bboolean\s+(true|false)\b/.exec(stdout);
  if (!match) {
    return null;
  }
  return match[1] === "true";
}

function readSessionType(env: NodeJS.ProcessEnv): LinuxSessionType {
  const declared = env.XDG_SESSION_TYPE?.trim().toLowerCase();
  if (declared === "wayland" || declared === "x11") {
    return declared;
  }
  // XDG_SESSION_TYPE is absent or non-graphical (tty), so fall back to the
  // display sockets. Wayland first: a Wayland session usually also exports
  // DISPLAY for XWayland.
  if (nonEmpty(env.WAYLAND_DISPLAY)) {
    return "wayland";
  }
  if (nonEmpty(env.DISPLAY)) {
    return "x11";
  }
  return "unknown";
}

function readDesktop(env: NodeJS.ProcessEnv): string[] {
  return (env.XDG_CURRENT_DESKTOP ?? "")
    .split(":")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function readDistro(io: LinuxEnvironmentIo): LinuxDistro | null {
  for (const filePath of OS_RELEASE_PATHS) {
    const contents = io.readTextFile(filePath);
    if (contents !== null) {
      return parseOsRelease(contents);
    }
  }
  return null;
}

function parseOsRelease(contents: string): LinuxDistro | null {
  const fields = new Map<string, string>();
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    fields.set(
      trimmed.slice(0, separator).trim(),
      unquote(trimmed.slice(separator + 1).trim()),
    );
  }

  const distro: LinuxDistro = {
    id: nonEmpty(fields.get("ID")),
    versionId: nonEmpty(fields.get("VERSION_ID")),
    prettyName: nonEmpty(fields.get("PRETTY_NAME")),
  };
  if (
    distro.id === null &&
    distro.versionId === null &&
    distro.prettyName === null
  ) {
    return null;
  }
  return distro;
}

// os-release values may be shell-quoted, with backslash escapes inside.
function unquote(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return value;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

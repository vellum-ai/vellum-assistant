import { afterEach, describe, expect, test } from "bun:test";

import {
  buildSanitizedEnv,
  SAFE_ENV_VARS,
  WINDOWS_SAFE_ENV_VARS,
} from "../safe-env.js";

describe("safe-env Qdrant forwarding", () => {
  const priorPort = process.env.QDRANT_HTTP_PORT;
  const priorUrl = process.env.QDRANT_URL;

  afterEach(() => {
    if (priorPort == null) {
      delete process.env.QDRANT_HTTP_PORT;
    } else {
      process.env.QDRANT_HTTP_PORT = priorPort;
    }
    if (priorUrl == null) {
      delete process.env.QDRANT_URL;
    } else {
      process.env.QDRANT_URL = priorUrl;
    }
  });

  test("QDRANT_HTTP_PORT is on the allowlist and forwarded to subprocesses", () => {
    expect(SAFE_ENV_VARS).toContain("QDRANT_HTTP_PORT");

    process.env.QDRANT_HTTP_PORT = "6543";
    const env = buildSanitizedEnv();
    expect(env.QDRANT_HTTP_PORT).toBe("6543");
  });

  test("QDRANT_URL is stripped — it would flip QdrantManager to external mode", () => {
    expect(SAFE_ENV_VARS).not.toContain("QDRANT_URL");

    process.env.QDRANT_URL = "http://external:6333";
    const env = buildSanitizedEnv();
    expect(env.QDRANT_URL).toBeUndefined();
  });
});

describe("safe-env Windows forwarding", () => {
  test("forwards runtime paths only to Windows children", () => {
    const keys = [
      "SystemRoot",
      "COMSPEC",
      "USERPROFILE",
      "LOCALAPPDATA",
      "PATHEXT",
    ] as const;
    const previous = Object.fromEntries(
      keys.map((key) => [key, process.env[key]]),
    );

    try {
      process.env.SystemRoot = "C:\\Windows";
      process.env.COMSPEC = "C:\\Windows\\System32\\cmd.exe";
      process.env.USERPROFILE = "C:\\Users\\Alice";
      process.env.LOCALAPPDATA = "C:\\Users\\Alice\\AppData\\Local";
      process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";

      expect(WINDOWS_SAFE_ENV_VARS).toContain("SystemRoot");
      const windowsEnv = buildSanitizedEnv("win32");
      expect(windowsEnv.SystemRoot).toBe("C:\\Windows");
      expect(windowsEnv.COMSPEC).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(windowsEnv.USERPROFILE).toBe("C:\\Users\\Alice");
      expect(windowsEnv.LOCALAPPDATA).toBe("C:\\Users\\Alice\\AppData\\Local");
      expect(windowsEnv.PATHEXT).toBe(".COM;.EXE;.BAT;.CMD");

      const posixEnv = buildSanitizedEnv("linux");
      expect(posixEnv.SystemRoot).toBeUndefined();
      expect(posixEnv.COMSPEC).toBeUndefined();
      expect(posixEnv.USERPROFILE).toBeUndefined();
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value == null) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  test("matches Windows environment names case-insensitively", () => {
    const windowsEnv = buildSanitizedEnv("win32", {
      Path: "C:\\Windows\\System32;C:\\Program Files\\Vellum",
      systemroot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    });

    expect(windowsEnv.PATH).toBe(
      "C:\\Windows\\System32;C:\\Program Files\\Vellum",
    );
    expect(windowsEnv.SystemRoot).toBe("C:\\Windows");
    expect(windowsEnv.COMSPEC).toBe("C:\\Windows\\System32\\cmd.exe");
  });
});

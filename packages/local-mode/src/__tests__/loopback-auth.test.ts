import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { headerHostIsLoopback, originIsAllowed } from "../util";
import { isActiveAssistant } from "../lockfile";

describe("headerHostIsLoopback", () => {
  test("rejects DNS-rebound hosts", () => {
    expect(headerHostIsLoopback("attacker.example")).toBe(false);
    expect(headerHostIsLoopback("evil.com:3000")).toBe(false);
  });

  test("accepts loopback hosts", () => {
    expect(headerHostIsLoopback("127.0.0.1:3000")).toBe(true);
    expect(headerHostIsLoopback("localhost:3000")).toBe(true);
    expect(headerHostIsLoopback("localhost")).toBe(true);
    expect(headerHostIsLoopback("[::1]:3000")).toBe(true);
  });

  test("rejects undefined/empty", () => {
    expect(headerHostIsLoopback(undefined)).toBe(false);
    expect(headerHostIsLoopback("")).toBe(false);
  });
});

describe("originIsAllowed", () => {
  test("rejects cross-origin requests", () => {
    expect(originIsAllowed("https://attacker.example")).toBe(false);
    expect(originIsAllowed("http://evil.com")).toBe(false);
  });

  test("accepts localhost origins", () => {
    expect(originIsAllowed("http://localhost:3000")).toBe(true);
    expect(originIsAllowed("http://127.0.0.1:3000")).toBe(true);
  });

  test("allows absent origin (non-browser clients)", () => {
    expect(originIsAllowed(undefined)).toBe(true);
  });
});

describe("isActiveAssistant", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vellum-local-mode-test-"));
    tempDirs.push(dir);
    return dir;
  }

  test("returns true for the active assistant", () => {
    const dir = makeTempDir();
    const lockfilePath = path.join(dir, "lockfile.json");
    fs.writeFileSync(
      lockfilePath,
      JSON.stringify({
        assistants: [{ assistantId: "active" }, { assistantId: "inactive" }],
        activeAssistant: "active",
      }),
    );
    expect(isActiveAssistant([lockfilePath], "active")).toBe(true);
  });

  test("returns false for a non-active assistant", () => {
    const dir = makeTempDir();
    const lockfilePath = path.join(dir, "lockfile.json");
    fs.writeFileSync(
      lockfilePath,
      JSON.stringify({
        assistants: [{ assistantId: "active" }, { assistantId: "inactive" }],
        activeAssistant: "active",
      }),
    );
    expect(isActiveAssistant([lockfilePath], "inactive")).toBe(false);
  });

  test("returns false when lockfile does not exist", () => {
    expect(isActiveAssistant(["/nonexistent/lockfile.json"], "any")).toBe(false);
  });
});

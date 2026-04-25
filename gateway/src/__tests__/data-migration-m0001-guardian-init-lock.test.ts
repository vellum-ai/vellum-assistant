import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { up } from "../db/data-migrations/m0001-guardian-init-lock.js";

let testHome: string;
let legacyDir: string;
let protectedDir: string;

import { testSecurityDir } from "./test-preload.js";

const savedHome = process.env.HOME;

function seedLegacy(file: string, contents: string): void {
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, file), contents);
}

beforeEach(() => {
  testHome = join(
    tmpdir(),
    `vellum-m0001-test-${randomBytes(6).toString("hex")}`,
  );
  legacyDir = join(testHome, ".vellum");
  protectedDir = join(legacyDir, "protected");
  mkdirSync(protectedDir, { recursive: true });

  process.env.HOME = testHome;
  process.env.GATEWAY_SECURITY_DIR = protectedDir;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  process.env.GATEWAY_SECURITY_DIR = testSecurityDir;
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe("m0001-guardian-init-lock", () => {
  test("copies both lock files into the protected dir", () => {
    seedLegacy("guardian-init.lock", "2026-04-01T00:00:00.000Z");
    seedLegacy("guardian-init-consumed.json", "[0]\n");

    expect(up()).toBe("done");

    expect(
      readFileSync(join(protectedDir, "guardian-init.lock"), "utf-8"),
    ).toBe("2026-04-01T00:00:00.000Z");
    expect(
      readFileSync(join(protectedDir, "guardian-init-consumed.json"), "utf-8"),
    ).toBe("[0]\n");
  });

  test("copies only files that exist at the legacy path", () => {
    seedLegacy("guardian-init.lock", "only-lock");

    expect(up()).toBe("done");

    expect(existsSync(join(protectedDir, "guardian-init.lock"))).toBe(true);
    expect(existsSync(join(protectedDir, "guardian-init-consumed.json"))).toBe(
      false,
    );
  });

  test("no-op when legacy files are absent", () => {
    expect(up()).toBe("done");
    expect(existsSync(join(protectedDir, "guardian-init.lock"))).toBe(false);
  });

  test("does not overwrite files already at the new path", () => {
    seedLegacy("guardian-init.lock", "legacy-lock");
    writeFileSync(join(protectedDir, "guardian-init.lock"), "new-lock");

    expect(up()).toBe("done");

    expect(
      readFileSync(join(protectedDir, "guardian-init.lock"), "utf-8"),
    ).toBe("new-lock");
  });

  test("no-op for a named-instance layout (different GATEWAY_SECURITY_DIR)", () => {
    // Simulate a named instance: its protected dir is NOT $HOME/.vellum/protected.
    const namedInstanceProtected = join(
      testHome,
      ".local",
      "share",
      "vellum",
      "assistants",
      "work",
      ".vellum",
      "protected",
    );
    mkdirSync(namedInstanceProtected, { recursive: true });
    process.env.GATEWAY_SECURITY_DIR = namedInstanceProtected;

    // A stray lock at the user's ~/.vellum (e.g. left behind by first-local).
    seedLegacy("guardian-init.lock", "first-local-lock");

    expect(up()).toBe("done");

    // Named instance's protected dir must NOT pick up first-local's lock.
    expect(existsSync(join(namedInstanceProtected, "guardian-init.lock"))).toBe(
      false,
    );
  });

  test("tolerates trailing slash in GATEWAY_SECURITY_DIR", () => {
    process.env.GATEWAY_SECURITY_DIR = `${protectedDir}/`;
    seedLegacy("guardian-init.lock", "trailing-slash-lock");

    expect(up()).toBe("done");

    expect(
      readFileSync(join(protectedDir, "guardian-init.lock"), "utf-8"),
    ).toBe("trailing-slash-lock");
  });
});

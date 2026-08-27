import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _listSharedAppsForTests,
  _resolveSharedAppDirForTests,
} from "../app-management-routes.js";

let rootDir: string;
let canonicalDir: string;
let legacyDir: string;

function writeSharedApp(dir: string, uuid: string, name: string): void {
  mkdirSync(join(dir, uuid), { recursive: true });
  writeFileSync(
    join(dir, `${uuid}-meta.json`),
    JSON.stringify({
      uuid,
      name,
      entry: "index.html",
      trustTier: "verified",
      installedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  writeFileSync(
    join(dir, uuid, "manifest.json"),
    JSON.stringify({ version: "1.0.0", content_id: `content-${uuid}` }),
  );
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "shared-app-roots-"));
  canonicalDir = join(rootDir, "canonical");
  legacyDir = join(rootDir, "legacy");
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe("shared app roots", () => {
  test("lists canonical and legacy apps after the canonical directory exists", () => {
    writeSharedApp(canonicalDir, "app-new", "New App");
    writeSharedApp(legacyDir, "app-legacy", "Legacy App");

    const apps = _listSharedAppsForTests([canonicalDir, legacyDir]);

    expect(apps.map((app) => app.uuid)).toEqual(["app-new", "app-legacy"]);
  });

  test("prefers the canonical copy when both roots contain the same app", () => {
    writeSharedApp(canonicalDir, "app-shared", "Canonical App");
    writeSharedApp(legacyDir, "app-shared", "Legacy App");

    const apps = _listSharedAppsForTests([canonicalDir, legacyDir]);

    expect(apps).toHaveLength(1);
    expect(apps[0]?.name).toBe("Canonical App");
    expect(
      _resolveSharedAppDirForTests("app-shared", [canonicalDir, legacyDir]),
    ).toBe(canonicalDir);
  });

  test("resolves a legacy app when it is absent from the canonical root", () => {
    mkdirSync(canonicalDir, { recursive: true });
    writeSharedApp(legacyDir, "app-legacy", "Legacy App");

    expect(
      _resolveSharedAppDirForTests("app-legacy", [canonicalDir, legacyDir]),
    ).toBe(legacyDir);
  });
});

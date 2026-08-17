import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findWebDistDir } from "../web-dist.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vellum-web-dist-"));
  tempDirs.push(dir);
  return dir;
}

function writeWebDist(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html>", "utf8");
}

const missingPackage = (): string => {
  throw new Error("package missing");
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finds web assets beside a packaged Windows CLI", () => {
  const root = makeTempDir();
  const runtimeDir = join(root, "runtime");
  const webDistDir = join(runtimeDir, "web-dist");
  writeWebDist(webDistDir);

  expect(
    findWebDistDir({
      execPath: join(runtimeDir, "vellum.exe"),
      platform: "win32",
      resolvePackage: missingPackage,
      startDir: join(root, "source"),
    }),
  ).toBe(webDistDir);
});

test("does not use the Windows runtime path on macOS", () => {
  const root = makeTempDir();
  const runtimeDir = join(root, "runtime");
  writeWebDist(join(runtimeDir, "web-dist"));

  expect(
    findWebDistDir({
      execPath: join(runtimeDir, "vellum"),
      platform: "darwin",
      resolvePackage: missingPackage,
      startDir: join(root, "source"),
    }),
  ).toBeNull();
});

test("preserves installed package and source checkout resolution", () => {
  const root = makeTempDir();
  const packageDir = join(root, "package");
  const packageDist = join(packageDir, "dist");
  writeWebDist(packageDist);
  writeFileSync(join(packageDir, "package.json"), "{}", "utf8");

  expect(
    findWebDistDir({
      platform: "linux",
      resolvePackage: () => join(packageDir, "package.json"),
      startDir: join(root, "missing-source"),
    }),
  ).toBe(packageDist);

  const sourceDist = join(root, "repo", "clients", "web", "dist");
  writeWebDist(sourceDist);
  expect(
    findWebDistDir({
      platform: "linux",
      resolvePackage: missingPackage,
      startDir: join(root, "repo", "cli", "src"),
    }),
  ).toBe(sourceDist);
});

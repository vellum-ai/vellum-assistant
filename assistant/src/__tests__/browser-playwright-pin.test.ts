/**
 * The runtime's playwright install has to ask for the same version the image
 * builds against, because the image bakes Chromium with it
 * (`assistant/Dockerfile`). A floating install resolves a playwright that
 * looks for a different browser build id, so the first `browser` call or PDF
 * export in a pod re-downloads Chromium instead of using the baked copy.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";

// The bundled import must miss so the runtime-install path is the one under
// test; a namespace without `chromium` is exactly what a compiled binary sees.
mock.module("playwright", () => ({}));

mock.module("../util/bun-runtime.js", () => ({
  ensureBun: async () => "/nonexistent/bun",
}));

const { importPlaywright, PLAYWRIGHT_VERSION } =
  await import("../tools/browser/runtime-check.js");
const { getExternalDir } = await import("../util/platform.js");

const realSpawn = Bun.spawn;
afterEach(() => {
  Bun.spawn = realSpawn;
});

/** Capture the install command; the import that follows it is expected to fail. */
async function captureInstallCommand(): Promise<string[] | undefined> {
  let command: string[] | undefined;
  Bun.spawn = ((cmd: string[]) => {
    command = cmd;
    return {
      exited: Promise.resolve(0),
      stderr: new Response("").body,
    };
  }) as unknown as typeof Bun.spawn;
  await importPlaywright().catch(() => {});
  return command;
}

describe("runtime playwright install", () => {
  test("requests the exact version the image builds against", async () => {
    expect(await captureInstallCommand()).toEqual([
      "/nonexistent/bun",
      "add",
      `playwright@${PLAYWRIGHT_VERSION}`,
    ]);
  });

  /**
   * A copy left behind by an earlier floating install disagrees with the baked
   * browser, so it is replaced rather than reused.
   */
  test("replaces a runtime copy pinned to a different version", async () => {
    const pwPkg = join(getExternalDir(), "node_modules", "playwright");
    mkdirSync(pwPkg, { recursive: true });
    writeFileSync(
      join(pwPkg, "package.json"),
      JSON.stringify({ name: "playwright", version: "0.0.1" }),
    );

    expect(await captureInstallCommand()).toEqual([
      "/nonexistent/bun",
      "add",
      `playwright@${PLAYWRIGHT_VERSION}`,
    ]);
  });

  test("reuses a runtime copy already at the pinned version", async () => {
    const pwPkg = join(getExternalDir(), "node_modules", "playwright");
    mkdirSync(pwPkg, { recursive: true });
    writeFileSync(
      join(pwPkg, "package.json"),
      JSON.stringify({ name: "playwright", version: PLAYWRIGHT_VERSION }),
    );

    expect(await captureInstallCommand()).toBeUndefined();
    expect(existsSync(join(pwPkg, "package.json"))).toBe(true);
  });
});

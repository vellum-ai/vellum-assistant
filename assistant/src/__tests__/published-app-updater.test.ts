/**
 * Tests that the auto-redeploy path deploys the app's *effective* HTML
 * (compiled dist/index.html) rather than the empty `htmlDefinition`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AppDefinition } from "../apps/app-store.js";

// ── Mocks ───────────────────────────────────────────────────────────────

let mockApp: AppDefinition | null = null;
let mockEffectiveHtml = "";
// A real temp app dir whose dist/index.html satisfies the compiled-output
// guard; individual tests point mockAppDir at a nonexistent path to exercise
// the skip branch without mocking node:fs (which would leak across files).
const realAppDir = join(tmpdir(), `published-app-updater-test-${Date.now()}`);
let mockAppDir = realAppDir;

mock.module("../apps/app-store.js", () => ({
  getApp: () => mockApp,
  getAppDirPath: () => mockAppDir,
  resolveEffectiveAppHtml: () => mockEffectiveHtml,
}));

let mockPublishedPage: {
  id: string;
  projectSlug?: string;
  htmlHash: string;
} | null = null;
const updatePublishedPageSpy = mock(() => {});

mock.module("../apps/published-pages-store.js", () => ({
  getActivePublishedPageByAppId: () => mockPublishedPage,
  updatePublishedPage: updatePublishedPageSpy,
}));

const deploySpy = mock(async (_args: { html: string; name: string }) => ({
  deploymentId: "dep-1",
  url: "https://example.vercel.app",
}));

mock.module("../services/vercel-deploy.js", () => ({
  deployHtmlToVercel: deploySpy,
}));

// credentialBroker.serverUse invokes execute(token) and reports success.
mock.module("../tools/credentials/broker.js", () => ({
  credentialBroker: {
    serverUse: async ({
      execute,
    }: {
      execute: (token: string) => Promise<unknown>;
    }) => {
      await execute("test-token");
      return { success: true };
    },
  },
}));

const { updatePublishedAppDeployment } =
  await import("../services/published-app-updater.js");

function makeApp(overrides: Partial<AppDefinition> = {}): AppDefinition {
  return {
    id: "app-1",
    name: "App",
    schemaJson: "{}",
    htmlDefinition: "",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("updatePublishedAppDeployment", () => {
  beforeEach(() => {
    mkdirSync(join(realAppDir, "dist"), { recursive: true });
    writeFileSync(join(realAppDir, "dist", "index.html"), "<html></html>");
    mockApp = makeApp();
    mockEffectiveHtml = "";
    mockPublishedPage = { id: "pp-1", projectSlug: "slug", htmlHash: "old" };
    mockAppDir = realAppDir;
    deploySpy.mockClear();
    updatePublishedPageSpy.mockClear();
  });

  afterEach(() => {
    rmSync(realAppDir, { recursive: true, force: true });
  });

  test("deploys the resolved effective HTML, not the empty htmlDefinition", async () => {
    // htmlDefinition is "" (as it is for every app); the real content comes
    // from resolveEffectiveAppHtml.
    mockApp = makeApp({ htmlDefinition: "" });
    mockEffectiveHtml = "<html><body>real app</body></html>";

    await updatePublishedAppDeployment("app-1");

    expect(deploySpy).toHaveBeenCalledTimes(1);
    expect(deploySpy.mock.calls[0][0].html).toBe(
      "<html><body>real app</body></html>",
    );
  });

  test("skips deploy when the app has no compiled output", async () => {
    mockApp = makeApp({ formatVersion: 2 });
    mockEffectiveHtml = "<p>App compilation failed.</p>";
    // A nonexistent app dir → dist/index.html is absent.
    mockAppDir = "/tmp/__vellum_test_nonexistent__/app-1";

    await updatePublishedAppDeployment("app-1");

    expect(deploySpy).not.toHaveBeenCalled();
  });

  test("skips deploy when content hash is unchanged", async () => {
    const html = "<html>same</html>";
    mockEffectiveHtml = html;
    const { createHash } = await import("node:crypto");
    mockPublishedPage = {
      id: "pp-1",
      htmlHash: createHash("sha256").update(html).digest("hex"),
    };

    await updatePublishedAppDeployment("app-1");

    expect(deploySpy).not.toHaveBeenCalled();
  });

  test("skips deploy when the app has no active published page", async () => {
    mockPublishedPage = null;
    mockEffectiveHtml = "<html>x</html>";

    await updatePublishedAppDeployment("app-1");

    expect(deploySpy).not.toHaveBeenCalled();
  });
});

/**
 * Tests that the auto-redeploy path deploys the app's *effective* HTML
 * (dist/index.html for multifile apps) rather than the empty `htmlDefinition`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AppDefinition } from "../apps/app-store.js";

// ── Mocks ───────────────────────────────────────────────────────────────

let mockApp: AppDefinition | null = null;
let mockIsMultifile = false;
let mockEffectiveHtml = "";
// A directory that does not exist on disk, so the multifile dist-existence
// guard reads `false` from the real fs without mocking node:fs (which would
// leak across test files).
let mockAppDir = "/tmp/__vellum_test_nonexistent__/app-1";

mock.module("../apps/app-store.js", () => ({
  getApp: () => mockApp,
  getAppDirPath: () => mockAppDir,
  isMultifileApp: () => mockIsMultifile,
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
    mockApp = makeApp();
    mockIsMultifile = false;
    mockEffectiveHtml = "";
    mockPublishedPage = { id: "pp-1", projectSlug: "slug", htmlHash: "old" };
    mockAppDir = "/tmp/__vellum_test_nonexistent__/app-1";
    deploySpy.mockClear();
    updatePublishedPageSpy.mockClear();
  });

  test("deploys the resolved effective HTML, not the empty htmlDefinition", async () => {
    // htmlDefinition is "" (as it is for every multifile app); the real
    // content comes from resolveEffectiveAppHtml. isMultifile=false here keeps
    // the dist guard out of the way so the assertion targets the html source.
    mockApp = makeApp({ htmlDefinition: "" });
    mockEffectiveHtml = "<html><body>real app</body></html>";

    await updatePublishedAppDeployment("app-1");

    expect(deploySpy).toHaveBeenCalledTimes(1);
    expect(deploySpy.mock.calls[0][0].html).toBe(
      "<html><body>real app</body></html>",
    );
  });

  test("skips deploy when a multifile app has no compiled output", async () => {
    mockIsMultifile = true;
    mockApp = makeApp({ formatVersion: 2 });
    mockEffectiveHtml = "<p>App compilation failed.</p>";
    // mockAppDir does not exist → dist/index.html is absent.

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

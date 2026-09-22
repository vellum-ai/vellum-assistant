import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { setOverridesForTesting } from "../__tests__/feature-flag-test-helpers.js";
import { shouldUseVirtualDesktopBrowser } from "../browser/virtual-desktop-target.js";
import { executeDesktopBrowserOperation } from "./desktop-browser-operations.js";
import { desktopDependencies } from "./desktop-dependencies.js";

const originalPlatform = process.env.IS_PLATFORM;
const originalContainerized = process.env.IS_CONTAINERIZED;
const context = {
  workingDir: "/tmp",
  conversationId: "conv-platform-gate",
  sourceActorPrincipalId: "user-123",
  trustClass: "guardian" as const,
  transportInterface: "web" as const,
  clientOs: "web" as const,
};
let status: ReturnType<typeof spyOn<typeof desktopDependencies, "getStatus">>;

beforeEach(() => {
  process.env.IS_CONTAINERIZED = "true";
  process.env.IS_PLATFORM = "false";
  setOverridesForTesting({ "assistant-desktop": true });
  status = spyOn(desktopDependencies, "getStatus").mockReturnValue({
    state: "ready",
  });
});

afterEach(() => {
  status.mockRestore();
  setOverridesForTesting({});
  if (originalPlatform === undefined) {
    delete process.env.IS_PLATFORM;
  } else {
    process.env.IS_PLATFORM = originalPlatform;
  }
  if (originalContainerized === undefined) {
    delete process.env.IS_CONTAINERIZED;
  } else {
    process.env.IS_CONTAINERIZED = originalContainerized;
  }
});

test("self-hosted Docker cannot automatically select or explicitly control virtual Chrome", async () => {
  expect(shouldUseVirtualDesktopBrowser(undefined, {}, context)).toBe(false);
  await expect(
    executeDesktopBrowserOperation("snapshot", {}, context),
  ).rejects.toThrow("only on enabled platform-hosted assistants");
  expect(status).not.toHaveBeenCalled();
});

test("platform web conversations select virtual Chrome even when image components are missing", () => {
  process.env.IS_PLATFORM = "true";
  expect(shouldUseVirtualDesktopBrowser(undefined, {}, context)).toBe(true);
  status.mockReturnValue({ state: "failed" });
  expect(shouldUseVirtualDesktopBrowser(undefined, {}, context)).toBe(true);
});

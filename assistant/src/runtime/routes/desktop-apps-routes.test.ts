import { afterEach, expect, spyOn, test } from "bun:test";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import { desktopAppManager } from "../../desktop/desktop-apps.js";
import { desktopDependencyInstaller } from "../../desktop/desktop-dependencies.js";
import { ROUTES } from "./desktop-setup-routes.js";

const post = ROUTES.find(
  (route) => route.operationId === "desktop_apps_action",
)!;
const originalContainer = process.env.IS_CONTAINERIZED;
afterEach(() => {
  if (originalContainer === undefined) {
    delete process.env.IS_CONTAINERIZED;
  } else {
    process.env.IS_CONTAINERIZED = originalContainer;
  }
  setOverridesForTesting({});
});

test("disabled desktops reject actions without installing", async () => {
  setOverridesForTesting({ "assistant-desktop": false });
  const add = spyOn(desktopAppManager, "add");
  try {
    await expect(
      post.handler({ body: { appId: "calculator", action: "add" } }),
    ).rejects.toThrow("not available");
    expect(add).not.toHaveBeenCalled();
  } finally {
    add.mockRestore();
  }
});

test("unknown apps, commands and invalid actions are rejected before package work", async () => {
  process.env.IS_CONTAINERIZED = "true";
  setOverridesForTesting({ "assistant-desktop": true });
  const add = spyOn(desktopAppManager, "add");
  const setup = spyOn(desktopDependencyInstaller, "getStatus").mockReturnValue({
    state: "ready",
  });
  try {
    for (const body of [
      { appId: "xcalc; touch /tmp/injected", action: "add" },
      { appId: "calculator", action: "delete" },
      { appId: "calculator", action: "add", command: "sh" },
    ]) {
      await expect(post.handler({ body })).rejects.toThrow(
        "Choose an available",
      );
    }
    expect(add).not.toHaveBeenCalled();
  } finally {
    add.mockRestore();
    setup.mockRestore();
  }
});

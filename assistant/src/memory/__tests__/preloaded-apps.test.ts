import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import type { AssistantConfig } from "../../config/schema.js";
import { getAppsDir } from "../app-store.js";
import {
  ACTIVATION_FLOW_FLAG,
  PERSONAL_PAGE_APP_ID,
  PERSONAL_PAGE_ARM,
  seedPreloadedApps,
} from "../preloaded-apps.js";

// The flag resolver reads the override cache and registry; the config
// argument is part of the signature but not consulted for resolution.
const config = {} as AssistantConfig;

function definitionPath(): string {
  return join(getAppsDir(), `${PERSONAL_PAGE_APP_ID}.json`);
}

function appDir(): string {
  return join(getAppsDir(), PERSONAL_PAGE_APP_ID);
}

beforeEach(() => {
  setOverridesForTesting({});
});

afterEach(() => {
  setOverridesForTesting({});
  rmSync(definitionPath(), { force: true });
  rmSync(appDir(), { recursive: true, force: true });
});

describe("seedPreloadedApps gating", () => {
  test("does not seed on the control arm", async () => {
    setOverridesForTesting({ [ACTIVATION_FLOW_FLAG]: "control" });
    await seedPreloadedApps(config);
    expect(existsSync(definitionPath())).toBe(false);
    expect(existsSync(appDir())).toBe(false);
  });

  test("does not seed on other treatment arms", async () => {
    setOverridesForTesting({ [ACTIVATION_FLOW_FLAG]: "variant-a" });
    await seedPreloadedApps(config);
    expect(existsSync(definitionPath())).toBe(false);
  });

  test("does not seed when the flag resolves to the registry default", async () => {
    // No override → declared default "control".
    await seedPreloadedApps(config);
    expect(existsSync(definitionPath())).toBe(false);
  });

  test("leaves an already-seeded, compiled app untouched", async () => {
    setOverridesForTesting({ [ACTIVATION_FLOW_FLAG]: PERSONAL_PAGE_ARM });

    const sentinelDefinition = JSON.stringify({
      id: PERSONAL_PAGE_APP_ID,
      userEdited: true,
    });
    mkdirSync(join(appDir(), "dist"), { recursive: true });
    writeFileSync(definitionPath(), sentinelDefinition, "utf-8");
    writeFileSync(
      join(appDir(), "dist", "index.html"),
      "<!-- compiled -->",
      "utf-8",
    );

    await seedPreloadedApps(config);

    // Seeding must not re-copy the template or rewrite the definition once
    // the app exists — its content is considered user-owned.
    expect(readFileSync(definitionPath(), "utf-8")).toBe(sentinelDefinition);
    expect(existsSync(join(appDir(), "src"))).toBe(false);
  });
});

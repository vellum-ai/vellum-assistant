/**
 * Seeds preloaded apps into the workspace apps directory at daemon startup.
 *
 * A preloaded app ships as plain source files under
 * `src/config/preloaded-apps/<dirName>/` and is copied into
 * `data/apps/<dirName>/` with a fixed, well-known app id, then compiled.
 * The assistant later populates it by overwriting designated content files
 * (e.g. the personal page's `src/profile-data.ts`) and calling app_refresh —
 * it never authors the layout itself.
 *
 * Seeding is idempotent and deliberately conservative: once the definition
 * JSON exists the app is considered user-owned (its content may have been
 * populated) and the template is never re-copied. A missing `dist/` triggers
 * a recompile only.
 *
 * Seeding is gated on the activation-flow experiment: only assistants in the
 * personal-page treatment arm get the app. The gate is evaluated once per
 * daemon startup — an assistant moved into the arm later picks it up on its
 * next restart, and an already-seeded app is never removed when the
 * assistant leaves the arm (it is user-owned by then).
 */

import { cpSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { compileApp } from "../bundler/app-compiler.js";
import {
  getAssistantFeatureFlagValue,
  initFeatureFlagOverrides,
} from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";
import { resolveBundledDir } from "../util/bundled-asset.js";
import { getLogger } from "../util/logger.js";
import { getAppsDir } from "./app-store.js";

const log = getLogger("preloaded-apps");

/** Well-known id (and dirName) of the personal landing page app. */
export const PERSONAL_PAGE_APP_ID = "personal-page";

/** Multivariate activation-flow experiment flag (scope "both"). */
export const ACTIVATION_FLOW_FLAG = "experiment-activation-flow-2026-06-03";

/** Arm of the activation-flow experiment that gets the preseeded page. */
export const PERSONAL_PAGE_ARM = "personal-page";

export async function seedPreloadedApps(
  config: AssistantConfig,
): Promise<void> {
  // The lifecycle hook fires this early in startup, possibly before the
  // gateway override fetch has completed. Await it here (no-op when already
  // cached; bounded retries otherwise) so the arm read below sees the
  // platform-assigned value rather than the registry default.
  await initFeatureFlagOverrides();

  const arm = getAssistantFeatureFlagValue(ACTIVATION_FLOW_FLAG, config);
  if (arm !== PERSONAL_PAGE_ARM) return;

  await seedPersonalPageApp();
}

async function seedPersonalPageApp(): Promise<void> {
  const appsDir = getAppsDir();
  const definitionPath = join(appsDir, `${PERSONAL_PAGE_APP_ID}.json`);
  const appDir = join(appsDir, PERSONAL_PAGE_APP_ID);
  const alreadySeeded = existsSync(definitionPath);

  if (alreadySeeded && existsSync(join(appDir, "dist", "index.html"))) {
    return;
  }

  if (!alreadySeeded) {
    const templateDir = resolveBundledDir(
      import.meta.dirname ?? __dirname,
      "../config/preloaded-apps/personal-page",
      "preloaded-apps/personal-page",
    );
    if (!existsSync(join(templateDir, "src"))) {
      log.warn(
        { templateDir },
        "Personal page template not found — skipping preloaded app seeding",
      );
      return;
    }

    cpSync(join(templateDir, "src"), join(appDir, "src"), { recursive: true });
    // Multifile (formatVersion 2) apps keep an empty root index.html; the
    // real entrypoint is src/index.html compiled into dist/. Matches the
    // on-disk shape produced by createApp().
    writeFileSync(join(appDir, "index.html"), "", "utf-8");

    const now = Date.now();
    const definition = {
      id: PERSONAL_PAGE_APP_ID,
      name: "Your Page",
      description:
        "A personal landing page the assistant fills in with what it learns about you.",
      icon: "✨",
      schemaJson: "{}",
      createdAt: now,
      updatedAt: now,
      formatVersion: 2,
      dirName: PERSONAL_PAGE_APP_ID,
    };
    writeFileSync(definitionPath, JSON.stringify(definition, null, 2), "utf-8");
    log.info({ appDir }, "Seeded personal page app");
  }

  const result = await compileApp(appDir);
  if (!result.ok) {
    log.warn(
      { errors: result.errors },
      "Personal page app failed to compile after seeding",
    );
  }
}

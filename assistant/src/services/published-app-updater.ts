/**
 * Background service that auto-redeploys published apps when their content changes.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  getApp,
  getAppDirPath,
  isMultifileApp,
  resolveEffectiveAppHtml,
} from "../apps/app-store.js";
import {
  getActivePublishedPageByAppId,
  updatePublishedPage,
} from "../apps/published-pages-store.js";
import { credentialBroker } from "../tools/credentials/broker.js";
import { getLogger } from "../util/logger.js";
import { deployHtmlToVercel } from "./vercel-deploy.js";

const log = getLogger("published-app-updater");

export async function updatePublishedAppDeployment(
  appId: string,
): Promise<void> {
  try {
    // 1. Check if this app has an active published deployment
    const publishedPage = getActivePublishedPageByAppId(appId);
    if (!publishedPage) return;

    // 2. Load the app and resolve its deployable HTML. For multifile apps the
    // real content lives in dist/index.html (compiled from src/), not in
    // htmlDefinition (which is "" for them) — using htmlDefinition directly
    // would deploy a blank page.
    const app = getApp(appId);
    if (!app) {
      log.warn({ appId }, "Published app not found");
      return;
    }

    // Skip rather than deploy the compile-failure fallback when a multifile
    // app has no compiled output (e.g. a concurrent compile failed); a later
    // successful compile re-triggers this path.
    if (
      isMultifileApp(app) &&
      !existsSync(join(getAppDirPath(app.id), "dist", "index.html"))
    ) {
      log.warn({ appId }, "Skipping auto-redeploy: compiled output missing");
      return;
    }

    const html = resolveEffectiveAppHtml(app);
    if (!html) return;

    // 3. Hash the current HTML and check if it changed
    const newHash = createHash("sha256").update(html).digest("hex");
    if (newHash === publishedPage.htmlHash) return; // No change

    // 4. Get Vercel token — don't prompt, just skip if unavailable
    const slug = publishedPage.projectSlug ?? `vellum-app-${appId}`;

    const useResult = await credentialBroker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "publish_page",
      execute: async (token) => {
        // 5. Deploy updated HTML using the same project slug
        const result = await deployHtmlToVercel({
          html,
          name: slug,
          token,
        });

        // 6. Update the published page record
        updatePublishedPage(publishedPage.id, {
          deploymentId: result.deploymentId,
          publicUrl: result.url,
          htmlHash: newHash,
          publishedAt: Date.now(),
        });

        log.info(
          { appId, deploymentId: result.deploymentId, url: result.url },
          "Auto-updated published app deployment",
        );

        return result;
      },
    });

    if (!useResult.success) {
      log.warn(
        { appId, reason: useResult.reason },
        "Could not auto-update published app — no Vercel credential available",
      );
    }
  } catch (err) {
    log.error({ err, appId }, "Failed to auto-update published app deployment");
  }
}

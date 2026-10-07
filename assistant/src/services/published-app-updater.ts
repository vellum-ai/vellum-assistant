/**
 * Background service that auto-redeploys published apps when their content changes.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  getApp,
  getAppDirPath,
  resolveEffectiveAppHtml,
} from "../apps/app-store.js";
import {
  getActivePublishedPageByAppId,
  updatePublishedPage,
} from "../apps/published-pages-store.js";
import { getLogger } from "../util/logger.js";
import {
  getPublishProvider,
  withPublishCredential,
} from "./publish/registry.js";

const log = getLogger("published-app-updater");

export async function updatePublishedAppDeployment(
  appId: string,
): Promise<void> {
  try {
    // 1. Check if this app has an active published deployment
    const publishedPage = getActivePublishedPageByAppId(appId);
    if (!publishedPage) {
      return;
    }

    // 2. Load the app and resolve its deployable HTML: the real content
    // lives in dist/index.html (compiled from src/), inlined into a
    // self-contained page.
    const app = getApp(appId);
    if (!app) {
      log.warn({ appId }, "Published app not found");
      return;
    }

    // Skip rather than deploy the compile-failure fallback when the app has
    // no compiled output (e.g. a concurrent compile failed); a later
    // successful compile re-triggers this path.
    if (!existsSync(join(getAppDirPath(app.id), "dist", "index.html"))) {
      log.warn({ appId }, "Skipping auto-redeploy: compiled output missing");
      return;
    }

    const html = resolveEffectiveAppHtml(app);
    if (!html) {
      return;
    }

    // 3. Hash the current HTML and check if it changed
    const newHash = createHash("sha256").update(html).digest("hex");
    if (newHash === publishedPage.htmlHash) {
      return;
    } // No change

    // 4. Deploy through the configured provider, reusing the project slug the
    // record already carries. Never prompts: an unavailable credential just
    // skips this redeploy.
    const provider = getPublishProvider();
    const slug = publishedPage.projectSlug ?? `vellum-app-${appId}`;

    const outcome = await withPublishCredential(
      provider,
      "publish_page",
      async (token) => {
        const result = await provider.deploy(
          html,
          {
            appId,
            name: app.name,
            slug,
            previousDeploymentId: publishedPage.deploymentId,
          },
          token,
        );

        // 5. Update the published page record
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
    );

    if (!outcome.success) {
      log.warn(
        { appId, provider: provider.id, reason: outcome.reason },
        "Could not auto-update published app deployment",
      );
    }
  } catch (err) {
    log.error({ err, appId }, "Failed to auto-update published app deployment");
  }
}

/**
 * Background service that auto-redeploys published apps when their content changes.
 */

import { createHash } from 'node:crypto';
import { getLogger } from '../util/logger.js';
import { getActivePublishedPageByAppId, updatePublishedPage } from '../memory/published-pages-store.js';
import { getApp } from '../memory/app-store.js';
import { deployHtmlToVercel } from './vercel-deploy.js';
import { credentialBroker } from '../tools/credentials/broker.js';

const log = getLogger('published-app-updater');

export async function updatePublishedAppDeployment(appId: string): Promise<void> {
  try {
    // 1. Check if this app has an active published deployment
    const publishedPage = getActivePublishedPageByAppId(appId);
    if (!publishedPage) return;

    // 2. Load the app to get current HTML
    const app = getApp(appId);
    if (!app || !app.htmlDefinition) {
      log.warn({ appId }, 'Published app not found or has no HTML');
      return;
    }

    // 3. Hash the current HTML and check if it changed
    const newHash = createHash('sha256').update(app.htmlDefinition).digest('hex');
    if (newHash === publishedPage.htmlHash) return; // No change

    // 4. Get Vercel token — don't prompt, just skip if unavailable
    const slug = publishedPage.projectSlug ?? `vellum-page-${Date.now()}`;

    const useResult = await credentialBroker.serverUse({
      service: 'vercel',
      field: 'api_token',
      toolName: 'publish_page',
      execute: async (token) => {
        // 5. Deploy updated HTML using the same project slug
        const result = await deployHtmlToVercel({
          html: app.htmlDefinition,
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
          'Auto-updated published app deployment',
        );

        return result;
      },
    });

    if (!useResult.success) {
      log.warn({ appId, reason: useResult.reason }, 'Could not auto-update published app — no Vercel credential available');
    }
  } catch (err) {
    log.error({ err, appId }, 'Failed to auto-update published app deployment');
  }
}

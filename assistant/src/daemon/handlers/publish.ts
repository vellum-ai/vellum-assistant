import * as net from 'node:net';
import { v4 as uuid } from 'uuid';
import { createHash } from 'node:crypto';
import { deployHtmlToVercel, deleteVercelDeployment } from '../../services/vercel-deploy.js';
import { createPublishedPage, getPublishedPageByHash, markDeleted, getPublishedPageByDeploymentId, updatePublishedPage } from '../../memory/published-pages-store.js';
import { setSecureKey } from '../../security/secure-keys.js';
import { getCredentialMetadata, upsertCredentialMetadata } from '../../tools/credentials/metadata-store.js';
import { credentialBroker } from '../../tools/credentials/broker.js';
import type {
  PublishPageRequest,
  UnpublishPageRequest,
} from '../ipc-protocol.js';
import { log, requestSecretStandalone, defineHandlers, type HandlerContext } from './shared.js';

export async function handlePublishPage(
  msg: PublishPageRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    // Hash the HTML for dedup — can be done before credential check
    const htmlHash = createHash('sha256').update(msg.html).digest('hex');

    // Check if already published (no credential needed)
    const existing = getPublishedPageByHash(htmlHash);
    if (existing) {
      // Link the existing deployment to this app if not already linked
      if (msg.appId && !existing.appId) {
        updatePublishedPage(existing.id, { appId: msg.appId });
      }
      ctx.send(socket, {
        type: 'publish_page_response',
        success: true,
        publicUrl: existing.publicUrl,
        deploymentId: existing.deploymentId,
      });
      return;
    }

    const publishExecute = async (token: string) => {
      const name = msg.title
        ? msg.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
        : `vellum-page-${Date.now()}`;

      const result = await deployHtmlToVercel({ html: msg.html, name, token });

      const id = uuid();
      createPublishedPage({
        id,
        deploymentId: result.deploymentId,
        publicUrl: result.url,
        pageTitle: msg.title,
        htmlHash,
        appId: msg.appId,
        projectSlug: name,
      });

      return { url: result.url, deploymentId: result.deploymentId };
    };

    let useResult = await credentialBroker.serverUse({
      service: 'vercel',
      field: 'api_token',
      toolName: 'publish_page',
      execute: publishExecute,
    });

    // If no credential found, prompt the user and retry
    if (!useResult.success && useResult.reason?.includes('No credential found')) {
      const allowedTools = ['publish_page', 'unpublish_page'];
      const secretResult = await requestSecretStandalone(socket, ctx, {
        service: 'vercel',
        field: 'api_token',
        label: 'Vercel API Token',
        description: 'Required to publish site apps to the web. Create a token at vercel.com/account/tokens.',
        placeholder: 'Enter your Vercel API token',
        purpose: 'Publish site apps to the web',
        allowedTools,
        allowedDomains: ['api.vercel.com'],
      });

      if (!secretResult.value) {
        ctx.send(socket, {
          type: 'publish_page_response',
          success: false,
          error: 'Cancelled',
        });
        return;
      }

      if (secretResult.delivery === 'transient_send') {
        // One-time send: inject for single use without persisting to keychain.
        // Metadata must exist for broker policy checks.
        if (!getCredentialMetadata('vercel', 'api_token')) {
          upsertCredentialMetadata('vercel', 'api_token', { allowedTools });
        }
        credentialBroker.injectTransient('vercel', 'api_token', secretResult.value);
      } else {
        // Default: persist to keychain
        const storageKey = `credential:vercel:api_token`;
        setSecureKey(storageKey, secretResult.value);
        upsertCredentialMetadata('vercel', 'api_token', { allowedTools });
      }

      // Retry with the newly stored credential
      useResult = await credentialBroker.serverUse({
        service: 'vercel',
        field: 'api_token',
        toolName: 'publish_page',
        execute: publishExecute,
      });
    }

    if (useResult.success && useResult.result) {
      ctx.send(socket, {
        type: 'publish_page_response',
        success: true,
        publicUrl: useResult.result.url,
        deploymentId: useResult.result.deploymentId,
      });
    } else {
      log.error({ reason: useResult.reason }, 'Failed to publish page');
      ctx.send(socket, {
        type: 'publish_page_response',
        success: false,
        error: useResult.reason ?? 'Failed to publish page',
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to publish page');
    ctx.send(socket, {
      type: 'publish_page_response',
      success: false,
      error: message,
    });
  }
}

export async function handleUnpublishPage(
  msg: UnpublishPageRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const useResult = await credentialBroker.serverUse({
      service: 'vercel',
      field: 'api_token',
      toolName: 'unpublish_page',
      execute: async (token) => {
        await deleteVercelDeployment(msg.deploymentId, token);

        const record = getPublishedPageByDeploymentId(msg.deploymentId);
        if (record) {
          markDeleted(record.id);
        }
      },
    });

    if (useResult.success) {
      ctx.send(socket, {
        type: 'unpublish_page_response',
        success: true,
      });
    } else {
      log.error({ reason: useResult.reason, deploymentId: msg.deploymentId }, 'Failed to unpublish page');
      ctx.send(socket, {
        type: 'unpublish_page_response',
        success: false,
        error: useResult.reason ?? 'Failed to unpublish page',
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, deploymentId: msg.deploymentId }, 'Failed to unpublish page');
    ctx.send(socket, {
      type: 'unpublish_page_response',
      success: false,
      error: message,
    });
  }
}

export const publishHandlers = defineHandlers({
  publish_page: handlePublishPage,
  unpublish_page: handleUnpublishPage,
});

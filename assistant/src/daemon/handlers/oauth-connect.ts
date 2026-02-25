import * as net from 'node:net';

import { orchestrateOAuthConnect } from '../../oauth/connect-orchestrator.js';
import { getProviderProfile, resolveService } from '../../oauth/provider-profiles.js';
import { getSecureKey } from '../../security/secure-keys.js';
import { assertMetadataWritable } from '../../tools/credentials/metadata-store.js';
import type { OAuthConnectStartRequest } from '../ipc-protocol.js';
import { defineHandlers, type HandlerContext, log } from './shared.js';

export async function handleOAuthConnectStart(
  msg: OAuthConnectStartRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    assertMetadataWritable();
  } catch {
    ctx.send(socket, {
      type: 'oauth_connect_result',
      success: false,
      error: 'Credential metadata file has an unrecognized version. Cannot store OAuth credentials.',
    });
    return;
  }

  try {
    if (!msg.service) {
      ctx.send(socket, {
        type: 'oauth_connect_result',
        success: false,
        error: 'Missing required field: service',
      });
      return;
    }

    const resolvedService = resolveService(msg.service);

    // Look up client credentials from the keychain
    const clientId =
      getSecureKey(`credential:${resolvedService}:client_id`) ??
      getSecureKey(`credential:${resolvedService}:oauth_client_id`);

    if (!clientId) {
      ctx.send(socket, {
        type: 'oauth_connect_result',
        success: false,
        error: `No client_id found for "${msg.service}". Store it first via the credential vault.`,
      });
      return;
    }

    const clientSecret =
      getSecureKey(`credential:${resolvedService}:client_secret`) ??
      getSecureKey(`credential:${resolvedService}:oauth_client_secret`) ??
      undefined;

    // Fail early when client_secret is required but missing — guide the
    // user to collect it from the keychain rather than letting the OAuth
    // flow proceed and fail at token exchange.
    const profile = getProviderProfile(resolvedService);
    const requiresSecret = profile?.setup?.requiresClientSecret
      ?? !!(profile?.tokenEndpointAuthMethod || profile?.extraParams);
    if (requiresSecret && !clientSecret) {
      ctx.send(socket, {
        type: 'oauth_connect_result',
        success: false,
        error: `client_secret is required for "${msg.service}" but not found in the keychain. Store it first via the credential vault.`,
      });
      return;
    }

    const result = await orchestrateOAuthConnect({
      service: msg.service,
      requestedScopes: msg.requestedScopes,
      clientId,
      clientSecret,
      isInteractive: true,
      openUrl: (url: string) => {
        ctx.send(socket, { type: 'open_url', url });
      },
    });

    if (!result.success) {
      ctx.send(socket, {
        type: 'oauth_connect_result',
        success: false,
        error: result.error,
      });
      return;
    }

    if (result.deferred) {
      // Deferred flows should not happen for interactive daemon connections,
      // but handle gracefully by returning the auth URL as an error hint.
      ctx.send(socket, {
        type: 'oauth_connect_result',
        success: false,
        error: `OAuth flow was deferred. Open this URL to authorize: ${result.authUrl}`,
      });
      return;
    }

    ctx.send(socket, {
      type: 'oauth_connect_result',
      success: true,
      grantedScopes: result.grantedScopes,
      accountInfo: result.accountInfo,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, service: msg.service }, 'OAuth connect flow failed');

    let userError: string;
    const lower = message.toLowerCase();
    if (lower.includes('timed out')) {
      userError = 'OAuth authentication timed out. Please try again.';
    } else if (lower.includes('user_cancelled') || lower.includes('cancelled')) {
      userError = 'OAuth authentication was cancelled.';
    } else if (lower.includes('denied') || lower.includes('invalid_grant')) {
      userError = 'The authorization request was denied. Please try again.';
    } else {
      userError = 'OAuth authentication failed. Please try again.';
    }

    ctx.send(socket, {
      type: 'oauth_connect_result',
      success: false,
      error: userError,
    });
  }
}

export const oauthConnectHandlers = defineHandlers({
  oauth_connect_start: handleOAuthConnectStart,
});

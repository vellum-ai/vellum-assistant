import * as net from 'node:net';
import { loadRawConfig } from '../../config/loader.js';
import { getSecureKey, setSecureKey } from '../../security/secure-keys.js';
import { startOAuth2Flow } from '../../security/oauth2.js';
import { upsertCredentialMetadata, getCredentialMetadata } from '../../tools/credentials/metadata-store.js';
import type { TwitterAuthStartRequest, TwitterAuthStatusRequest } from '../ipc-protocol.js';
import { log, type HandlerContext, type DispatchMap } from './shared.js';
import type { OAuth2Config } from '../../security/oauth2.js';

export async function handleTwitterAuthStart(
  _msg: TwitterAuthStartRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const raw = loadRawConfig();
    const mode = (raw.twitterIntegrationMode as string | undefined) ?? 'local_byo';
    if (mode !== 'local_byo') {
      ctx.send(socket, {
        type: 'twitter_auth_result',
        success: false,
        error: 'Twitter integration mode must be "local_byo" to use this flow.',
      });
      return;
    }

    const clientId = getSecureKey('credential:integration:twitter:oauth_client_id');
    if (!clientId) {
      ctx.send(socket, {
        type: 'twitter_auth_result',
        success: false,
        error: 'No Twitter client credentials configured. Please set up your Client ID first.',
      });
      return;
    }

    const clientSecret = getSecureKey('credential:integration:twitter:oauth_client_secret') || undefined;

    const oauthConfig: OAuth2Config = {
      authUrl: 'https://twitter.com/i/oauth2/authorize',
      tokenUrl: 'https://api.x.com/2/oauth2/token',
      scopes: ['tweet.read', 'users.read', 'offline.access'],
      clientId,
      clientSecret,
      extraParams: {},
    };

    const result = await startOAuth2Flow(oauthConfig, {
      openUrl: (url: string) => {
        ctx.send(socket, { type: 'open_url', url });
      },
    });

    setSecureKey('credential:integration:twitter:access_token', result.tokens.accessToken);
    if (result.tokens.refreshToken) {
      setSecureKey('credential:integration:twitter:refresh_token', result.tokens.refreshToken);
    }

    // Verify identity via Twitter API
    let accountInfo: string | undefined;
    try {
      const userResp = await fetch('https://api.x.com/2/users/me', {
        headers: { Authorization: `Bearer ${result.tokens.accessToken}` },
      });
      if (userResp.ok) {
        const userData = (await userResp.json()) as { data?: { username?: string } };
        if (userData.data?.username) {
          accountInfo = `@${userData.data.username}`;
        }
      }
    } catch (err) {
      log.warn({ err }, 'Failed to verify Twitter identity after OAuth');
    }

    upsertCredentialMetadata('integration:twitter', 'access_token', {
      accountInfo,
      allowedTools: ['twitter_post', 'twitter_read'],
    });

    ctx.send(socket, {
      type: 'twitter_auth_result',
      success: true,
      accountInfo,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Twitter OAuth flow failed');
    ctx.send(socket, {
      type: 'twitter_auth_result',
      success: false,
      error: `Twitter authentication failed: ${message}`,
    });
  }
}

export function handleTwitterAuthStatus(
  _msg: TwitterAuthStatusRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const accessToken = getSecureKey('credential:integration:twitter:access_token');
    const raw = loadRawConfig();
    const mode = (raw.twitterIntegrationMode as 'local_byo' | 'managed' | undefined) ?? 'local_byo';
    const meta = getCredentialMetadata('integration:twitter', 'access_token');

    ctx.send(socket, {
      type: 'twitter_auth_status_response',
      connected: !!accessToken,
      accountInfo: meta?.accountInfo ?? undefined,
      mode,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to get Twitter auth status');
    ctx.send(socket, {
      type: 'twitter_auth_status_response',
      connected: false,
      error: message,
    });
  }
}

export const twitterAuthHandlers: Partial<DispatchMap> = {
  twitter_auth_start: handleTwitterAuthStart,
  twitter_auth_status: handleTwitterAuthStatus,
};

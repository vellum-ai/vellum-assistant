import * as net from 'node:net';
import { loadRawConfig } from '../../config/loader.js';
import { getSecureKey, setSecureKey, deleteSecureKey } from '../../security/secure-keys.js';
import { startOAuth2Flow } from '../../security/oauth2.js';
import { upsertCredentialMetadata, getCredentialMetadata } from '../../tools/credentials/metadata-store.js';
import type { TwitterAuthStartRequest, TwitterAuthStatusRequest } from '../ipc-protocol.js';
import { log, defineHandlers, type HandlerContext } from './shared.js';
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

    // Verify identity via Twitter API before persisting any tokens
    let accountInfo: string;
    try {
      const userResp = await fetch('https://api.x.com/2/users/me', {
        headers: { Authorization: `Bearer ${result.tokens.accessToken}` },
      });
      if (!userResp.ok) {
        log.error({ status: userResp.status }, 'Twitter identity verification returned non-2xx');
        ctx.send(socket, {
          type: 'twitter_auth_result',
          success: false,
          error: 'Failed to verify Twitter identity. Please try again.',
        });
        return;
      }
      const userData = (await userResp.json()) as { data?: { username?: string } };
      if (!userData.data?.username) {
        log.error({ userData }, 'Twitter identity verification returned no username');
        ctx.send(socket, {
          type: 'twitter_auth_result',
          success: false,
          error: 'Failed to verify Twitter identity. Please try again.',
        });
        return;
      }
      accountInfo = `@${userData.data.username}`;
    } catch (err) {
      log.error({ err }, 'Twitter identity verification fetch failed');
      ctx.send(socket, {
        type: 'twitter_auth_result',
        success: false,
        error: 'Failed to verify Twitter identity. Please try again.',
      });
      return;
    }

    // Persist tokens only after successful verification
    setSecureKey('credential:integration:twitter:access_token', result.tokens.accessToken);
    if (result.tokens.refreshToken) {
      setSecureKey('credential:integration:twitter:refresh_token', result.tokens.refreshToken);
    } else {
      deleteSecureKey('credential:integration:twitter:refresh_token');
    }

    upsertCredentialMetadata('integration:twitter', 'access_token', {
      accountInfo,
      allowedTools: ['twitter_post', 'twitter_read'],
      allowedDomains: [],
      oauth2TokenUrl: 'https://api.x.com/2/oauth2/token',
      oauth2ClientId: clientId,
      oauth2ClientSecret: clientSecret ?? null,
      grantedScopes: result.grantedScopes,
      expiresAt: result.tokens.expiresIn ? Date.now() + result.tokens.expiresIn * 1000 : null,
    });

    ctx.send(socket, {
      type: 'twitter_auth_result',
      success: true,
      accountInfo,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Twitter OAuth flow failed');

    let userError: string;
    const lower = message.toLowerCase();
    if (lower.includes('timed out')) {
      userError = 'Twitter authentication timed out. Please try again.';
    } else if (lower.includes('user_cancelled') || lower.includes('cancelled')) {
      userError = 'Twitter authentication was cancelled.';
    } else if (lower.includes('denied') || lower.includes('invalid_grant')) {
      userError = 'Twitter denied the authorization request. Please try again.';
    } else {
      userError = 'Twitter authentication failed. Please try again.';
    }

    ctx.send(socket, {
      type: 'twitter_auth_result',
      success: false,
      error: userError,
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

export const twitterAuthHandlers = defineHandlers({
  twitter_auth_start: handleTwitterAuthStart,
  twitter_auth_status: handleTwitterAuthStatus,
});

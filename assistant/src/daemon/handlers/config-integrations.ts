import * as net from 'node:net';
import { loadRawConfig, saveRawConfig } from '../../config/loader.js';
import { getSecureKey, setSecureKey, deleteSecureKey } from '../../security/secure-keys.js';
import { upsertCredentialMetadata, deleteCredentialMetadata, getCredentialMetadata } from '../../tools/credentials/metadata-store.js';
import type {
  VercelApiConfigRequest,
  TwitterIntegrationConfigRequest,
} from '../ipc-protocol.js';
import { log, defineHandlers, type HandlerContext } from './shared.js';

export function handleVercelApiConfig(
  msg: VercelApiConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    if (msg.action === 'get') {
      const existing = getSecureKey('credential:vercel:api_token');
      ctx.send(socket, {
        type: 'vercel_api_config_response',
        hasToken: !!existing,
        success: true,
      });
    } else if (msg.action === 'set') {
      if (!msg.apiToken) {
        ctx.send(socket, {
          type: 'vercel_api_config_response',
          hasToken: false,
          success: false,
          error: 'apiToken is required for set action',
        });
        return;
      }
      const stored = setSecureKey('credential:vercel:api_token', msg.apiToken);
      if (!stored) {
        ctx.send(socket, {
          type: 'vercel_api_config_response',
          hasToken: false,
          success: false,
          error: 'Failed to store API token in secure storage',
        });
        return;
      }
      upsertCredentialMetadata('vercel', 'api_token', {
        allowedTools: ['publish_page', 'unpublish_page'],
      });
      ctx.send(socket, {
        type: 'vercel_api_config_response',
        hasToken: true,
        success: true,
      });
    } else {
      deleteSecureKey('credential:vercel:api_token');
      deleteCredentialMetadata('vercel', 'api_token');
      ctx.send(socket, {
        type: 'vercel_api_config_response',
        hasToken: false,
        success: true,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to handle Vercel API config');
    ctx.send(socket, {
      type: 'vercel_api_config_response',
      hasToken: false,
      success: false,
      error: message,
    });
  }
}

export function handleTwitterIntegrationConfig(
  msg: TwitterIntegrationConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    if (msg.action === 'get') {
      const raw = loadRawConfig();
      const mode = (raw.twitterIntegrationMode as 'local_byo' | 'managed' | undefined) ?? 'local_byo';
      const strategy = (raw.twitterOperationStrategy as 'oauth' | 'browser' | 'auto' | undefined) ?? 'auto';
      const strategyConfigured = Object.prototype.hasOwnProperty.call(raw, 'twitterOperationStrategy');
      const localClientConfigured = !!getSecureKey('credential:integration:twitter:oauth_client_id');
      const connected = !!getSecureKey('credential:integration:twitter:access_token');
      const meta = getCredentialMetadata('integration:twitter', 'access_token');
      ctx.send(socket, {
        type: 'twitter_integration_config_response',
        success: true,
        mode,
        managedAvailable: false,
        localClientConfigured,
        connected,
        accountInfo: meta?.accountInfo ?? undefined,
        strategy,
        strategyConfigured,
      });
    } else if (msg.action === 'get_strategy') {
      const raw = loadRawConfig();
      const strategy = (raw.twitterOperationStrategy as 'oauth' | 'browser' | 'auto' | undefined) ?? 'auto';
      const strategyConfigured = Object.prototype.hasOwnProperty.call(raw, 'twitterOperationStrategy');
      ctx.send(socket, {
        type: 'twitter_integration_config_response',
        success: true,
        managedAvailable: false,
        localClientConfigured: !!getSecureKey('credential:integration:twitter:oauth_client_id'),
        connected: !!getSecureKey('credential:integration:twitter:access_token'),
        strategy,
        strategyConfigured,
      });
    } else if (msg.action === 'set_strategy') {
      const valid = ['oauth', 'browser', 'auto'];
      const value = msg.strategy;
      if (!value || !valid.includes(value)) {
        ctx.send(socket, {
          type: 'twitter_integration_config_response',
          success: false,
          managedAvailable: false,
          localClientConfigured: false,
          connected: false,
          error: `Invalid strategy value: ${String(value)}. Must be one of: ${valid.join(', ')}`,
        });
        return;
      }
      const raw = loadRawConfig();
      raw.twitterOperationStrategy = value;
      saveRawConfig(raw);
      ctx.send(socket, {
        type: 'twitter_integration_config_response',
        success: true,
        managedAvailable: false,
        localClientConfigured: !!getSecureKey('credential:integration:twitter:oauth_client_id'),
        connected: !!getSecureKey('credential:integration:twitter:access_token'),
        strategy: value as 'oauth' | 'browser' | 'auto',
        strategyConfigured: true,
      });
    } else if (msg.action === 'set_mode') {
      const raw = loadRawConfig();
      raw.twitterIntegrationMode = msg.mode ?? 'local_byo';
      saveRawConfig(raw);
      ctx.send(socket, {
        type: 'twitter_integration_config_response',
        success: true,
        mode: msg.mode ?? 'local_byo',
        managedAvailable: false,
        localClientConfigured: !!getSecureKey('credential:integration:twitter:oauth_client_id'),
        connected: !!getSecureKey('credential:integration:twitter:access_token'),
      });
    } else if (msg.action === 'set_local_client') {
      if (!msg.clientId) {
        ctx.send(socket, {
          type: 'twitter_integration_config_response',
          success: false,
          managedAvailable: false,
          localClientConfigured: false,
          connected: false,
          error: 'clientId is required for set_local_client action',
        });
        return;
      }
      const previousClientId = getSecureKey('credential:integration:twitter:oauth_client_id');
      const storedId = setSecureKey('credential:integration:twitter:oauth_client_id', msg.clientId);
      if (!storedId) {
        ctx.send(socket, {
          type: 'twitter_integration_config_response',
          success: false,
          managedAvailable: false,
          localClientConfigured: false,
          connected: false,
          error: 'Failed to store client ID in secure storage',
        });
        return;
      }
      if (msg.clientSecret) {
        const storedSecret = setSecureKey('credential:integration:twitter:oauth_client_secret', msg.clientSecret);
        if (!storedSecret) {
          // Roll back the client ID to its previous value to avoid inconsistent OAuth state
          if (previousClientId) {
            setSecureKey('credential:integration:twitter:oauth_client_id', previousClientId);
          } else {
            deleteSecureKey('credential:integration:twitter:oauth_client_id');
          }
          ctx.send(socket, {
            type: 'twitter_integration_config_response',
            success: false,
            managedAvailable: false,
            localClientConfigured: !!previousClientId,
            connected: false,
            error: 'Failed to store client secret in secure storage',
          });
          return;
        }
      } else {
        // Clear any stale secret when updating client without a secret (e.g. switching to PKCE)
        deleteSecureKey('credential:integration:twitter:oauth_client_secret');
      }
      ctx.send(socket, {
        type: 'twitter_integration_config_response',
        success: true,
        managedAvailable: false,
        localClientConfigured: true,
        connected: !!getSecureKey('credential:integration:twitter:access_token'),
      });
    } else if (msg.action === 'clear_local_client') {
      // If connected, disconnect first
      if (getSecureKey('credential:integration:twitter:access_token')) {
        deleteSecureKey('credential:integration:twitter:access_token');
        deleteSecureKey('credential:integration:twitter:refresh_token');
        deleteCredentialMetadata('integration:twitter', 'access_token');
      }
      deleteSecureKey('credential:integration:twitter:oauth_client_id');
      deleteSecureKey('credential:integration:twitter:oauth_client_secret');
      ctx.send(socket, {
        type: 'twitter_integration_config_response',
        success: true,
        managedAvailable: false,
        localClientConfigured: false,
        connected: false,
      });
    } else if (msg.action === 'disconnect') {
      deleteSecureKey('credential:integration:twitter:access_token');
      deleteSecureKey('credential:integration:twitter:refresh_token');
      deleteCredentialMetadata('integration:twitter', 'access_token');
      ctx.send(socket, {
        type: 'twitter_integration_config_response',
        success: true,
        managedAvailable: false,
        localClientConfigured: !!getSecureKey('credential:integration:twitter:oauth_client_id'),
        connected: false,
      });
    } else {
      ctx.send(socket, {
        type: 'twitter_integration_config_response',
        success: false,
        managedAvailable: false,
        localClientConfigured: false,
        connected: false,
        error: `Unknown action: ${String((msg as unknown as Record<string, unknown>).action)}`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to handle Twitter integration config');
    ctx.send(socket, {
      type: 'twitter_integration_config_response',
      success: false,
      managedAvailable: false,
      localClientConfigured: false,
      connected: false,
      error: message,
    });
  }
}

export const integrationHandlers = defineHandlers({
  vercel_api_config: handleVercelApiConfig,
  twitter_integration_config: handleTwitterIntegrationConfig,
});

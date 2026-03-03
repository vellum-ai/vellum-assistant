import * as net from 'node:net';

import {
  API_KEY_PROVIDERS,
  getConfig,
  invalidateConfigCache,
} from '../../config/loader.js';
import { initializeProviders } from '../../providers/registry.js';
import { deleteSecureKey, setSecureKey } from '../../security/secure-keys.js';
import {
  assertMetadataWritable,
  deleteCredentialMetadata,
  upsertCredentialMetadata,
} from '../../tools/credentials/metadata-store.js';
import type { SecretsConfigRequest } from '../ipc-protocol.js';
import { defineHandlers, type HandlerContext, log } from './shared.js';

export function handleSecretsConfig(
  msg: SecretsConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const { secretType, name, value } = msg;

    if (msg.action === 'set') {
      if (!value) {
        ctx.send(socket, { type: 'secrets_config_response', success: false, error: 'value is required for set action' });
        return;
      }

      if (secretType === 'api_key') {
        if (!API_KEY_PROVIDERS.includes(name as (typeof API_KEY_PROVIDERS)[number])) {
          ctx.send(socket, {
            type: 'secrets_config_response',
            success: false,
            error: `Unknown API key provider: ${name}. Valid providers: ${API_KEY_PROVIDERS.join(', ')}`,
          });
          return;
        }
        const stored = setSecureKey(name, value);
        if (!stored) {
          ctx.send(socket, { type: 'secrets_config_response', success: false, error: 'Failed to store API key in secure storage' });
          return;
        }
        invalidateConfigCache();
        initializeProviders(getConfig());
        log.info({ provider: name }, 'API key updated via IPC');
        ctx.send(socket, { type: 'secrets_config_response', success: true, secretType, name });
        return;
      }

      if (secretType === 'credential') {
        const colonIdx = name.indexOf(':');
        if (colonIdx < 1 || colonIdx === name.length - 1) {
          ctx.send(socket, {
            type: 'secrets_config_response',
            success: false,
            error: 'For credential type, name must be in "service:field" format (e.g. "github:api_token")',
          });
          return;
        }
        assertMetadataWritable();
        const service = name.slice(0, colonIdx);
        const field = name.slice(colonIdx + 1);
        const key = `credential:${service}:${field}`;
        const stored = setSecureKey(key, value);
        if (!stored) {
          ctx.send(socket, { type: 'secrets_config_response', success: false, error: 'Failed to store credential in secure storage' });
          return;
        }
        upsertCredentialMetadata(service, field, {});
        log.info({ service, field }, 'Credential added via IPC');
        ctx.send(socket, { type: 'secrets_config_response', success: true, secretType, name });
        return;
      }

      ctx.send(socket, {
        type: 'secrets_config_response',
        success: false,
        error: `Unknown secret type: ${secretType}. Valid types: api_key, credential`,
      });
      return;
    }

    if (msg.action === 'delete') {
      if (secretType === 'api_key') {
        if (!API_KEY_PROVIDERS.includes(name as (typeof API_KEY_PROVIDERS)[number])) {
          ctx.send(socket, {
            type: 'secrets_config_response',
            success: false,
            error: `Unknown API key provider: ${name}. Valid providers: ${API_KEY_PROVIDERS.join(', ')}`,
          });
          return;
        }
        const deleted = deleteSecureKey(name);
        if (!deleted) {
          ctx.send(socket, { type: 'secrets_config_response', success: false, error: `API key not found: ${name}` });
          return;
        }
        invalidateConfigCache();
        initializeProviders(getConfig());
        log.info({ provider: name }, 'API key deleted via IPC');
        ctx.send(socket, { type: 'secrets_config_response', success: true, secretType, name });
        return;
      }

      if (secretType === 'credential') {
        const colonIdx = name.indexOf(':');
        if (colonIdx < 1 || colonIdx === name.length - 1) {
          ctx.send(socket, {
            type: 'secrets_config_response',
            success: false,
            error: 'For credential type, name must be in "service:field" format (e.g. "github:api_token")',
          });
          return;
        }
        assertMetadataWritable();
        const service = name.slice(0, colonIdx);
        const field = name.slice(colonIdx + 1);
        const key = `credential:${service}:${field}`;
        const deleted = deleteSecureKey(key);
        if (!deleted) {
          ctx.send(socket, { type: 'secrets_config_response', success: false, error: `Credential not found: ${name}` });
          return;
        }
        deleteCredentialMetadata(service, field);
        log.info({ service, field }, 'Credential deleted via IPC');
        ctx.send(socket, { type: 'secrets_config_response', success: true, secretType, name });
        return;
      }

      ctx.send(socket, {
        type: 'secrets_config_response',
        success: false,
        error: `Unknown secret type: ${secretType}. Valid types: api_key, credential`,
      });
      return;
    }

    ctx.send(socket, { type: 'secrets_config_response', success: false, error: `Unknown action: ${String(msg.action)}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, secretType: msg.secretType, name: msg.name }, 'secrets_config handler error');
    ctx.send(socket, { type: 'secrets_config_response', success: false, error: message });
  }
}

export const secretsHandlers = defineHandlers({
  secrets_config: handleSecretsConfig,
});

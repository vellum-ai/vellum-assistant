/**
 * Integration registry — manages integration definitions and lifecycle.
 *
 * Connection status is derived live from vault presence rather than a
 * separate status store.
 */

import type { IntegrationDefinition, IntegrationStatus } from './types.js';
import { getSecureKey, deleteSecureKey } from '../security/secure-keys.js';
import {
  getCredentialMetadata,
  deleteCredentialMetadata,
} from '../tools/credentials/metadata-store.js';

const integrations = new Map<string, IntegrationDefinition>();

export function registerIntegration(definition: IntegrationDefinition): void {
  integrations.set(definition.id, definition);
}

export function getIntegration(id: string): IntegrationDefinition | undefined {
  return integrations.get(id);
}

export function listIntegrations(): IntegrationDefinition[] {
  return [...integrations.values()];
}

/** Derive connection status from vault presence. */
export function getStatus(id: string): IntegrationStatus {
  const def = integrations.get(id);
  if (!def) {
    return { id, connected: false, error: 'Integration not found' };
  }

  const accessToken = getSecureKey(`integration:${id}:access_token`);
  if (!accessToken) {
    return { id, connected: false };
  }

  const metadata = getCredentialMetadata(`integration:${id}`, 'access_token');
  return {
    id,
    connected: true,
    connectedAt: metadata?.createdAt,
    lastUsed: metadata?.updatedAt,
  };
}

/** Get status for all registered integrations. */
export function listStatuses(): IntegrationStatus[] {
  return listIntegrations().map((def) => getStatus(def.id));
}

/** Remove all credentials for an integration from the vault. */
export function disconnect(id: string): void {
  const def = integrations.get(id);
  if (!def) return;

  for (const field of def.credentialFields) {
    deleteSecureKey(`integration:${id}:${field}`);
    deleteCredentialMetadata(`integration:${id}`, field);
  }
}

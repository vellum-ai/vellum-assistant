import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import {
  getStatus,
  listStatuses,
  listIntegrations,
  getIntegration,
  isConfigured,
} from '../../integrations/registry.js';
import {
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
  invalidateConfigCache,
  getConfig,
} from '../../config/loader.js';
import { startOAuth2Flow } from '../../integrations/oauth2.js';
import { setSecureKey } from '../../security/secure-keys.js';
import { upsertCredentialMetadata } from '../credentials/metadata-store.js';

class IntegrationManageTool implements Tool {
  name = 'integration_manage';
  description = 'Query integration status, list integrations, configure credentials, or connect an integration';
  category = 'integrations';
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'set_client_id', 'list', 'connect'],
            description: 'The operation to perform.',
          },
          integration_id: {
            type: 'string',
            description: 'Integration ID (required for status, set_client_id, and connect).',
          },
          client_id: {
            type: 'string',
            description: 'OAuth client ID to store (only for set_client_id action).',
          },
        },
        required: ['action'],
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const action = input.action as string;

    switch (action) {
      case 'status': {
        const integrationId = input.integration_id as string | undefined;
        if (!integrationId) {
          return { content: 'Error: integration_id is required for status action', isError: true };
        }

        const def = getIntegration(integrationId);
        if (!def) {
          return { content: `Error: integration "${integrationId}" not found`, isError: true };
        }

        const status = getStatus(integrationId);
        const configured = isConfigured(integrationId);

        const result = {
          id: def.id,
          name: def.name,
          connected: status.connected,
          configured,
          accountInfo: status.accountInfo ?? null,
          setupSkillId: def.setupSkillId ?? null,
          setupHint: configured ? null : (def.setupHint ?? null),
        };

        return { content: JSON.stringify(result, null, 2), isError: false };
      }

      case 'set_client_id': {
        const integrationId = input.integration_id as string | undefined;
        const clientId = input.client_id as string | undefined;

        if (!integrationId) {
          return { content: 'Error: integration_id is required for set_client_id action', isError: true };
        }
        if (!clientId) {
          return { content: 'Error: client_id is required for set_client_id action', isError: true };
        }

        const def = getIntegration(integrationId);
        if (!def) {
          return { content: `Error: integration "${integrationId}" not found`, isError: true };
        }

        const raw = loadRawConfig();
        setNestedValue(raw, `integrations.${integrationId}.clientId`, clientId);
        saveRawConfig(raw);
        invalidateConfigCache();

        return {
          content: `Client ID configured for "${integrationId}". The user can now connect via Settings.`,
          isError: false,
        };
      }

      case 'connect': {
        const integrationId = input.integration_id as string | undefined;
        if (!integrationId) {
          return { content: 'Error: integration_id is required for connect action', isError: true };
        }

        const def = getIntegration(integrationId);
        if (!def) {
          return { content: `Error: integration "${integrationId}" not found`, isError: true };
        }

        if (def.authType !== 'oauth2' || !def.oauth2Config) {
          return { content: `Error: integration "${integrationId}" does not support OAuth2`, isError: true };
        }

        const config = getConfig();
        const integrationConfig = config.integrations[integrationId];
        const clientId = integrationConfig?.clientId || def.oauth2Config.clientId;

        if (!clientId) {
          return { content: `Error: no clientId configured for "${integrationId}". Run set_client_id first.`, isError: true };
        }

        if (!context.sendToClient) {
          return { content: 'Error: connect action requires an interactive client session', isError: true };
        }

        try {
          const oauthConfig = { ...def.oauth2Config, clientId };
          const { tokens, grantedScopes } = await startOAuth2Flow(oauthConfig, {
            openUrl: (url) => {
              context.sendToClient!({ type: 'open_url', url, title: `Connect ${def.name}` });
            },
          });

          const tokenStored = setSecureKey(`integration:${def.id}:access_token`, tokens.accessToken);
          if (!tokenStored) {
            return { content: 'Error: failed to store access token in secure storage', isError: true };
          }

          const expiresAt = tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined;

          let accountInfo: string | undefined;
          const userinfoUrl = def.oauth2Config.userinfoUrl;
          if (userinfoUrl && grantedScopes.some((s) => s.includes('userinfo'))) {
            try {
              const resp = await fetch(userinfoUrl, {
                headers: { Authorization: `Bearer ${tokens.accessToken}` },
              });
              if (resp.ok) {
                const info = await resp.json() as { email?: string };
                accountInfo = info.email;
              }
            } catch {
              // Non-fatal
            }
          }

          upsertCredentialMetadata(`integration:${def.id}`, 'access_token', {
            allowedTools: def.allowedTools,
            expiresAt,
            grantedScopes,
            accountInfo: accountInfo ?? null,
          });

          if (tokens.refreshToken) {
            const refreshStored = setSecureKey(`integration:${def.id}:refresh_token`, tokens.refreshToken);
            if (refreshStored) {
              upsertCredentialMetadata(`integration:${def.id}`, 'refresh_token', {});
            }
          }

          return {
            content: `Successfully connected "${def.name}"${accountInfo ? ` as ${accountInfo}` : ''}. The integration is now ready to use.`,
            isError: false,
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Unknown error during OAuth flow';
          return { content: `Error connecting "${integrationId}": ${message}`, isError: true };
        }
      }

      case 'list': {
        const defs = listIntegrations();
        const statuses = listStatuses();
        const statusMap = new Map(statuses.map((s) => [s.id, s]));

        const entries = defs.map((def) => {
          const status = statusMap.get(def.id);
          const configured = isConfigured(def.id);
          return {
            id: def.id,
            name: def.name,
            connected: status?.connected ?? false,
            configured,
            accountInfo: status?.accountInfo ?? null,
          };
        });

        return { content: JSON.stringify(entries, null, 2), isError: false };
      }

      default:
        return { content: `Error: unknown action "${action}"`, isError: true };
    }
  }
}

registerTool(new IntegrationManageTool());

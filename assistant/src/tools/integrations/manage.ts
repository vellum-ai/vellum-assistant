import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
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
} from '../../config/loader.js';

class IntegrationManageTool implements Tool {
  name = 'integration_manage';
  description = 'Query integration status, list integrations, or configure integration credentials';
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
            enum: ['status', 'set_client_id', 'list'],
            description: 'The operation to perform.',
          },
          integration_id: {
            type: 'string',
            description: 'Integration ID (required for status and set_client_id).',
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

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
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

export const integrationManageTool = new IntegrationManageTool();

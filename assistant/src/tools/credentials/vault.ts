import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import {
  getSecureKey,
  setSecureKey,
  deleteSecureKey,
  listSecureKeys,
} from '../../security/secure-keys.js';

/**
 * Retrieve the actual secret value for a credential.
 * Used internally (e.g. by browser_fill_credential) — never exposed as tool output.
 */
export function getCredentialValue(service: string, field: string): string | undefined {
  return getSecureKey(`credential:${service}:${field}`);
}

class CredentialStoreTool implements Tool {
  name = 'credential_store';
  description = 'Store, list, or delete credentials in the secure vault';
  category = 'credentials';
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
            enum: ['store', 'list', 'delete'],
            description: 'The operation to perform',
          },
          service: {
            type: 'string',
            description: 'Service name, e.g. gmail, github',
          },
          field: {
            type: 'string',
            description: 'Field name, e.g. password, username, recovery_email',
          },
          value: {
            type: 'string',
            description: 'The credential value (only for store action)',
          },
        },
        required: ['action'],
      },
    };
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const action = input.action as string;

    switch (action) {
      case 'store': {
        const service = input.service as string | undefined;
        const field = input.field as string | undefined;
        const value = input.value as string | undefined;

        if (!service || typeof service !== 'string') {
          return { content: 'Error: service is required for store action', isError: true };
        }
        if (!field || typeof field !== 'string') {
          return { content: 'Error: field is required for store action', isError: true };
        }
        if (!value || typeof value !== 'string') {
          return { content: 'Error: value is required for store action', isError: true };
        }

        const key = `credential:${service}:${field}`;
        const ok = setSecureKey(key, value);
        if (!ok) {
          return { content: 'Error: failed to store credential', isError: true };
        }
        return { content: `Stored credential for ${service}/${field}.`, isError: false };
      }

      case 'list': {
        const allKeys = listSecureKeys();
        const credentialKeys = allKeys.filter((k) => k.startsWith('credential:'));
        const entries = credentialKeys.map((k) => {
          const parts = k.split(':');
          return { service: parts[1], field: parts.slice(2).join(':') };
        });
        return { content: JSON.stringify(entries, null, 2), isError: false };
      }

      case 'delete': {
        const service = input.service as string | undefined;
        const field = input.field as string | undefined;

        if (!service || typeof service !== 'string') {
          return { content: 'Error: service is required for delete action', isError: true };
        }
        if (!field || typeof field !== 'string') {
          return { content: 'Error: field is required for delete action', isError: true };
        }

        const key = `credential:${service}:${field}`;
        const ok = deleteSecureKey(key);
        if (!ok) {
          return { content: `Error: credential ${service}/${field} not found`, isError: true };
        }
        return { content: `Deleted credential for ${service}/${field}.`, isError: false };
      }

      default:
        return { content: `Error: unknown action "${action}"`, isError: true };
    }
  }
}

registerTool(new CredentialStoreTool());

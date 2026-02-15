import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import {
  getSecureKey,
  setSecureKey,
  deleteSecureKey,
  listSecureKeys,
  getBackendType,
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
  description = 'Store, list, delete, or prompt for credentials in the secure vault';
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
            enum: ['store', 'list', 'delete', 'prompt'],
            description: 'The operation to perform. Use "prompt" to ask the user for a secret via secure UI — the value never enters the conversation.',
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
          label: {
            type: 'string',
            description: 'Display label for the prompt UI (only for prompt action), e.g. "GitHub Personal Access Token"',
          },
          description: {
            type: 'string',
            description: 'Optional context shown in the prompt UI (only for prompt action), e.g. "Needed to push changes"',
          },
          placeholder: {
            type: 'string',
            description: 'Placeholder text for the input field (only for prompt action), e.g. "ghp_xxxxxxxxxxxx"',
          },
        },
        required: ['action'],
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
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
        const backend = getBackendType();
        if (backend === 'keychain') {
          return {
            content:
              'Listing credentials is not supported when using the OS keychain backend. ' +
              'Use get operations with specific service/field names instead.',
            isError: false,
          };
        }
        const allKeys = listSecureKeys();
        const credentialKeys = allKeys.filter((k) => k.startsWith('credential:'));
        const entries = credentialKeys.map((k) => {
          const rest = k.slice('credential:'.length);
          const colonIdx = rest.indexOf(':');
          const service = colonIdx >= 0 ? rest.slice(0, colonIdx) : rest;
          const field = colonIdx >= 0 ? rest.slice(colonIdx + 1) : '';
          return { service, field };
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

      case 'prompt': {
        const service = input.service as string | undefined;
        const field = input.field as string | undefined;

        if (!service || typeof service !== 'string') {
          return { content: 'Error: service is required for prompt action', isError: true };
        }
        if (!field || typeof field !== 'string') {
          return { content: 'Error: field is required for prompt action', isError: true };
        }

        if (!context.requestSecret) {
          return { content: 'Error: secret prompting not available in this context', isError: true };
        }

        const label = (input.label as string) || `${service} ${field}`;
        const description = input.description as string | undefined;
        const placeholder = input.placeholder as string | undefined;

        const value = await context.requestSecret({ service, field, label, description, placeholder });
        if (!value) {
          return { content: 'User cancelled the credential prompt.', isError: false };
        }

        const key = `credential:${service}:${field}`;
        const ok = setSecureKey(key, value);
        if (!ok) {
          return { content: 'Error: failed to store credential', isError: true };
        }
        return { content: `Credential stored for ${service}/${field}.`, isError: false };
      }

      default:
        return { content: `Error: unknown action "${action}"`, isError: true };
    }
  }
}

export const credentialStoreTool = new CredentialStoreTool();

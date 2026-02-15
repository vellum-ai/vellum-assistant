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
import { upsertCredentialMetadata, deleteCredentialMetadata } from './metadata-store.js';
import { validatePolicyInput, toPolicyFromInput } from './policy-validate.js';
import type { CredentialPolicyInput } from './policy-types.js';
import { getConfig } from '../../config/loader.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('credential-vault');

/**
 * Retrieve the actual secret value for a credential.
 * Internal to vault — callers must go through the CredentialBroker.
 */
function getCredentialValue(service: string, field: string): string | undefined {
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
          allowed_tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tools allowed to use this credential (for store/prompt actions), e.g. ["browser_fill_credential"]. Empty = deny all.',
          },
          allowed_domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Domains where this credential may be used (for store/prompt actions), e.g. ["github.com"]. Empty = deny all.',
          },
          usage_description: {
            type: 'string',
            description: 'Human-readable description of intended usage (for store/prompt actions), e.g. "GitHub login for pushing changes"',
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

        const policyInput: CredentialPolicyInput = {
          allowed_tools: input.allowed_tools as string[] | undefined,
          allowed_domains: input.allowed_domains as string[] | undefined,
          usage_description: input.usage_description as string | undefined,
        };
        const policyResult = validatePolicyInput(policyInput);
        if (!policyResult.valid) {
          return { content: `Error: ${policyResult.errors.join('; ')}`, isError: true };
        }
        const policy = toPolicyFromInput(policyInput);

        const key = `credential:${service}:${field}`;
        const ok = setSecureKey(key, value);
        if (!ok) {
          return { content: 'Error: failed to store credential', isError: true };
        }
        try {
          upsertCredentialMetadata(service, field, {
            allowedTools: policy.allowedTools,
            allowedDomains: policy.allowedDomains,
            usageDescription: policy.usageDescription,
          });
        } catch (err) {
          log.warn({ service, field, err }, 'metadata write failed after storing credential');
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
        try {
          deleteCredentialMetadata(service, field);
        } catch (err) {
          log.warn({ service, field, err }, 'metadata cleanup failed after deleting credential');
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

        const promptPolicyInput: CredentialPolicyInput = {
          allowed_tools: input.allowed_tools as string[] | undefined,
          allowed_domains: input.allowed_domains as string[] | undefined,
          usage_description: input.usage_description as string | undefined,
        };
        const promptPolicyResult = validatePolicyInput(promptPolicyInput);
        if (!promptPolicyResult.valid) {
          return { content: `Error: ${promptPolicyResult.errors.join('; ')}`, isError: true };
        }
        const promptPolicy = toPolicyFromInput(promptPolicyInput);

        const result = await context.requestSecret({
          service, field, label, description, placeholder,
          purpose: promptPolicy.usageDescription,
          allowedTools: promptPolicy.allowedTools.length > 0 ? promptPolicy.allowedTools : undefined,
          allowedDomains: promptPolicy.allowedDomains.length > 0 ? promptPolicy.allowedDomains : undefined,
        });
        if (!result.value) {
          return { content: 'User cancelled the credential prompt.', isError: false };
        }

        // Handle one-time send delivery: inject into context without persisting
        if (result.delivery === 'transient_send') {
          const config = getConfig();
          if (!config.secretDetection.allowOneTimeSend) {
            log.warn({ service, field }, 'One-time send requested but not enabled in config');
            return {
              content: 'Error: one-time send is not enabled. Set secretDetection.allowOneTimeSend to true in config.',
              isError: true,
            };
          }
          // SECURITY: value is used for the immediate action only, never stored or logged
          log.info({ service, field, delivery: 'transient_send' }, 'One-time secret delivery used');
          return {
            content: `One-time credential provided for ${service}/${field}. The value was NOT saved to the vault.`,
            isError: false,
          };
        }

        // Default: persist to keychain
        const key = `credential:${service}:${field}`;
        const ok = setSecureKey(key, result.value);
        if (!ok) {
          return { content: 'Error: failed to store credential', isError: true };
        }
        try {
          upsertCredentialMetadata(service, field, {
            allowedTools: promptPolicy.allowedTools,
            allowedDomains: promptPolicy.allowedDomains,
            usageDescription: promptPolicy.usageDescription,
          });
        } catch (err) {
          log.warn({ service, field, err }, 'metadata write failed after storing credential');
        }
        return { content: `Credential stored for ${service}/${field}.`, isError: false };
      }

      default:
        return { content: `Error: unknown action "${action}"`, isError: true };
    }
  }
}

export const credentialStoreTool = new CredentialStoreTool();

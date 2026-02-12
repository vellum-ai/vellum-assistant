import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import {
  createAccount,
  listAccounts,
  getAccount,
  updateAccount,
} from '../../memory/account-store.js';

class AccountManageTool implements Tool {
  name = 'account_manage';
  description = 'Create, list, get, or update account records';
  category = 'credentials';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'list', 'get', 'update'],
            description: 'CRUD operation',
          },
          id: {
            type: 'string',
            description: 'Account ID (for get/update)',
          },
          service: {
            type: 'string',
            description: 'Service name',
          },
          username: { type: 'string' },
          email: { type: 'string' },
          display_name: { type: 'string' },
          status: {
            type: 'string',
            enum: ['active', 'pending_verification', 'suspended'],
          },
          credential_ref: {
            type: 'string',
            description: 'Service name linking to credential vault',
          },
          metadata: { type: 'object' },
        },
        required: ['action'],
      },
    };
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const action = input.action as string;

    switch (action) {
      case 'create': {
        const service = input.service as string | undefined;
        if (!service || typeof service !== 'string') {
          return { content: 'Error: service is required for create action', isError: true };
        }

        const record = createAccount({
          service,
          username: input.username as string | undefined,
          email: input.email as string | undefined,
          displayName: input.display_name as string | undefined,
          status: input.status as string | undefined,
          credentialRef: input.credential_ref as string | undefined,
          metadata: input.metadata as Record<string, unknown> | undefined,
        });

        return { content: JSON.stringify(record, null, 2), isError: false };
      }

      case 'list': {
        const records = listAccounts({
          service: input.service as string | undefined,
          status: input.status as string | undefined,
        });
        return { content: JSON.stringify(records, null, 2), isError: false };
      }

      case 'get': {
        const id = input.id as string | undefined;
        if (!id || typeof id !== 'string') {
          return { content: 'Error: id is required for get action', isError: true };
        }

        const record = getAccount(id);
        if (!record) {
          return { content: `Error: account not found: ${id}`, isError: true };
        }
        return { content: JSON.stringify(record, null, 2), isError: false };
      }

      case 'update': {
        const id = input.id as string | undefined;
        if (!id || typeof id !== 'string') {
          return { content: 'Error: id is required for update action', isError: true };
        }

        const updated = updateAccount(id, {
          service: input.service as string | undefined,
          username: input.username as string | undefined,
          email: input.email as string | undefined,
          displayName: input.display_name as string | undefined,
          status: input.status as string | undefined,
          credentialRef: input.credential_ref as string | undefined,
          metadata: input.metadata as Record<string, unknown> | undefined,
        });

        if (!updated) {
          return { content: `Error: account not found: ${id}`, isError: true };
        }
        return { content: JSON.stringify(updated, null, 2), isError: false };
      }

      default:
        return { content: `Error: unknown action "${action}"`, isError: true };
    }
  }
}

registerTool(new AccountManageTool());

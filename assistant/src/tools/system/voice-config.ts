import { normalizeActivationKey } from '../../daemon/handlers/config-voice.js';
import { RiskLevel } from '../../permissions/types.js';
import type { ToolDefinition } from '../../providers/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';

const TOOL_NAME = 'voice_config_update';

export const voiceConfigUpdateTool: Tool = {
  name: TOOL_NAME,
  description:
    'Change the push-to-talk activation key. Valid keys: fn (Fn/Globe key), ctrl (Control key), fn_shift (Fn+Shift), none (disable PTT).',
  category: 'system',
  defaultRiskLevel: RiskLevel.Low,

  getDefinition(): ToolDefinition {
    return {
      name: TOOL_NAME,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          activation_key: {
            type: 'string',
            description:
              'The activation key to set. Accepts enum values (fn, ctrl, fn_shift, none) or natural language (e.g. "Control", "Fn+Shift", "Off").',
          },
        },
        required: ['activation_key'],
      },
    };
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const rawKey = input.activation_key;
    if (typeof rawKey !== 'string' || rawKey.trim() === '') {
      return {
        content: 'Error: activation_key is required and must be a non-empty string.',
        isError: true,
      };
    }

    const result = normalizeActivationKey(rawKey);
    if (!result.ok) {
      return { content: result.reason, isError: true };
    }

    if (context.sendToClient) {
      context.sendToClient({
        type: 'client_settings_update',
        key: 'activationKey',
        value: result.value,
      });
    }

    const labels: Record<string, string> = {
      fn: 'Fn/Globe key',
      ctrl: 'Control key',
      fn_shift: 'Fn+Shift',
      none: 'disabled',
    };

    return {
      content: `Push-to-talk activation key updated to ${labels[result.value]} (${result.value}).`,
      isError: false,
    };
  },
};

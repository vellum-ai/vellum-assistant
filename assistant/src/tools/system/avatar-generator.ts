import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import OpenAI from 'openai';

import { getConfig } from '../../config/loader.js';
import { RiskLevel } from '../../permissions/types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { getLogger } from '../../util/logger.js';
import { getWorkspaceDir } from '../../util/platform.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';

const log = getLogger('avatar-generator');

const TOOL_NAME = 'set_avatar';

/** Canonical path where the custom avatar PNG is stored. */
function getAvatarPath(): string {
  return join(getWorkspaceDir(), 'data', 'avatar', 'custom-avatar.png');
}

export const setAvatarTool: Tool = {
  name: TOOL_NAME,
  description:
    'Generate a custom avatar image from a text description using DALL-E. ' +
    'Saves the result as the assistant\'s avatar.',
  category: 'system',
  defaultRiskLevel: RiskLevel.Low,

  getDefinition(): ToolDefinition {
    return {
      name: TOOL_NAME,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description:
              'A text description of the desired avatar appearance, ' +
              'e.g. "a friendly purple cat with green eyes wearing a tiny hat".',
          },
        },
        required: ['description'],
      },
    };
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const description = input.description;
    if (typeof description !== 'string' || description.trim() === '') {
      return {
        content: 'Error: description is required and must be a non-empty string.',
        isError: true,
      };
    }

    // Retrieve the OpenAI API key from the daemon config
    const config = getConfig();
    const apiKey = config.apiKeys.openai;

    if (!apiKey) {
      return {
        content:
          'No OpenAI API key configured. Please set your OpenAI API key ' +
          '(via Settings or the credential_store tool) to use avatar generation.',
        isError: true,
      };
    }

    // Wrap the user description with prompt engineering for safe, avatar-appropriate output
    const prompt =
      'Cute, friendly, work-safe avatar character illustration. ' +
      'Round, simple design with soft colors. ' +
      `${description.trim()}. ` +
      'White or light background, digital art style.';

    try {
      const client = new OpenAI({ apiKey });

      log.info({ description: description.trim() }, 'Generating avatar via DALL-E');

      const response = await client.images.generate({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json',
      });

      const b64Data = response.data[0]?.b64_json;
      if (!b64Data) {
        log.error('DALL-E response contained no image data');
        return {
          content: 'Error: the image generation API returned no image data. Please try again.',
          isError: true,
        };
      }

      // Decode and save the PNG
      const avatarPath = getAvatarPath();
      const avatarDir = dirname(avatarPath);

      mkdirSync(avatarDir, { recursive: true });
      writeFileSync(avatarPath, Buffer.from(b64Data, 'base64'));

      log.info({ avatarPath }, 'Avatar saved successfully');

      // Side-effect hook in tool-side-effects.ts broadcasts avatar_updated to all clients.

      return {
        content: 'Avatar updated! Your new avatar will appear shortly.',
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ error: message }, 'Avatar generation failed');

      if (error instanceof OpenAI.APIError) {
        return {
          content: `Avatar generation failed (API error ${error.status}): ${error.message}`,
          isError: true,
        };
      }

      return {
        content: `Avatar generation failed: ${message}`,
        isError: true,
      };
    }
  },
};

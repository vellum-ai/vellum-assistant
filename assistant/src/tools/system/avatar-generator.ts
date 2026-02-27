import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';

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

/** Extract SVG content from Claude's response text. */
function extractSvg(text: string): string | null {
  // Try to find SVG within code fences first
  const fenced = text.match(/```(?:svg|xml)?\s*\n([\s\S]*?)```/);
  if (fenced) {
    const content = fenced[1].trim();
    if (content.includes('<svg')) return content;
  }

  // Try to find raw SVG tags
  const raw = text.match(/<svg[\s\S]*<\/svg>/);
  if (raw) return raw[0];

  return null;
}

export const setAvatarTool: Tool = {
  name: TOOL_NAME,
  description:
    'Generate a custom avatar image from a text description. ' +
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

    const config = getConfig();
    const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return {
        content:
          'No Anthropic API key configured. Please set your Anthropic API key to use avatar generation.',
        isError: true,
      };
    }

    try {
      const client = new Anthropic({ apiKey });

      log.info({ description: description.trim() }, 'Generating SVG avatar via Claude');

      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content:
              `Generate an SVG avatar based on this description: ${description.trim()}\n\n` +
              'Requirements:\n' +
              '- Output ONLY the SVG code, no explanation\n' +
              '- The SVG must be exactly 512x512 pixels (viewBox="0 0 512 512")\n' +
              '- Use a cute, friendly, work-safe illustration style\n' +
              '- Use vibrant but soft colors\n' +
              '- Keep the design simple and recognizable at small sizes (28px)\n' +
              '- Use a circular or rounded composition that fills the canvas\n' +
              '- Add a subtle background color (not white/transparent)\n' +
              '- Do NOT use external references, fonts, or images\n' +
              '- Use only basic SVG elements (circle, rect, path, ellipse, polygon, g, defs, linearGradient, radialGradient)',
          },
        ],
      });

      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        return {
          content: 'Error: Claude returned no text content for the avatar.',
          isError: true,
        };
      }

      const svgContent = extractSvg(textBlock.text);
      if (!svgContent) {
        log.error({ response: textBlock.text.slice(0, 500) }, 'Failed to extract SVG from response');
        return {
          content: 'Error: could not extract valid SVG from the generated response. Please try again.',
          isError: true,
        };
      }

      // Convert SVG to PNG at 1024x1024 for high-DPI displays
      const pngBuffer = await sharp(Buffer.from(svgContent))
        .resize(1024, 1024)
        .png()
        .toBuffer();

      const avatarPath = getAvatarPath();
      const avatarDir = dirname(avatarPath);

      mkdirSync(avatarDir, { recursive: true });
      writeFileSync(avatarPath, pngBuffer);

      log.info({ avatarPath }, 'Avatar saved successfully');

      // Side-effect hook in tool-side-effects.ts broadcasts avatar_updated to all clients.

      return {
        content: 'Avatar updated! Your new avatar will appear shortly.',
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ error: message }, 'Avatar generation failed');

      return {
        content: `Avatar generation failed: ${message}`,
        isError: true,
      };
    }
  },
};

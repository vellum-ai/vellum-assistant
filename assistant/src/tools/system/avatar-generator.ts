import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import sharp from 'sharp';

import { RiskLevel } from '../../permissions/types.js';
import {
  createTimeout,
  extractText,
  getConfiguredProvider,
  userMessage,
} from '../../providers/provider-send-message.js';
import type { Provider, ToolDefinition } from '../../providers/types.js';
import { getLogger } from '../../util/logger.js';
import { getWorkspaceDir } from '../../util/platform.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';

const log = getLogger('avatar-generator');

const TOOL_NAME = 'set_avatar';

/** Timeout for each SVG generation request (30 seconds). */
const GENERATION_TIMEOUT_MS = 30_000;

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

/**
 * Remove duplicate attributes from SVG elements.
 * Claude sometimes generates elements like `<rect rx="5" rx="5" ...>`
 * which is invalid XML and causes sharp/libvips to reject the SVG.
 */
function sanitizeSvg(svg: string): string {
  return svg.replace(/<(\w+)((?:\s+[^>]*?)?)>/g, (_match, tag: string, attrs: string) => {
    if (!attrs.trim()) return `<${tag}>`;
    const seen = new Set<string>();
    const unique: string[] = [];
    // Match individual attribute="value" or attribute='value' pairs
    const attrRegex = /\s+([\w-]+)(?:=(?:"[^"]*"|'[^']*'))?/g;
    let m: RegExpExecArray | null;
    while ((m = attrRegex.exec(attrs)) !== null) {
      const name = m[1];
      if (!seen.has(name)) {
        seen.add(name);
        unique.push(m[0]);
      }
    }
    return `<${tag}${unique.join('')}>`;
  });
}

/** Generate SVG text from the provider with the given prompt. */
async function generateSvg(provider: Provider, prompt: string): Promise<string | null> {
  const { signal, cleanup } = createTimeout(GENERATION_TIMEOUT_MS);
  try {
    const response = await provider.sendMessage(
      [userMessage(prompt)],
      undefined,
      undefined,
      {
        signal,
        config: {
          modelIntent: 'latency-optimized',
          max_tokens: 4096,
        },
      },
    );
    cleanup();
    return extractText(response) || null;
  } catch (err) {
    cleanup();
    throw err;
  }
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
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const description = input.description;
    if (typeof description !== 'string' || description.trim() === '') {
      return {
        content: 'Error: description is required and must be a non-empty string.',
        isError: true,
      };
    }

    const provider = getConfiguredProvider();
    if (!provider) {
      return {
        content: 'No LLM provider configured. Cannot generate avatar.',
        isError: true,
      };
    }

    try {
      log.info({ description: description.trim() }, 'Generating SVG avatar via provider');

      const prompt =
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
        '- Do NOT use filters, masks, clipPath, text, or foreignObject\n' +
        '- NEVER duplicate attributes on the same element\n' +
        '- Use only basic SVG elements (circle, rect, path, ellipse, polygon, g, defs, linearGradient, radialGradient)';

      const responseText = await generateSvg(provider, prompt);
      if (!responseText) {
        return {
          content: 'Error: provider returned no text content for the avatar.',
          isError: true,
        };
      }

      const rawSvg = extractSvg(responseText);
      if (!rawSvg) {
        log.error({ response: responseText.slice(0, 500) }, 'Failed to extract SVG from response');
        return {
          content: 'Error: could not extract valid SVG from the generated response. Please try again.',
          isError: true,
        };
      }

      // Sanitize SVG to fix common issues (e.g. duplicate attributes)
      const svgContent = sanitizeSvg(rawSvg);

      // Convert SVG to PNG at 1024x1024 for high-DPI displays
      let pngBuffer: Buffer;
      try {
        pngBuffer = await sharp(Buffer.from(svgContent))
          .resize(1024, 1024)
          .png()
          .toBuffer();
      } catch (renderErr) {
        const renderMsg = renderErr instanceof Error ? renderErr.message : String(renderErr);
        log.warn({ error: renderMsg }, 'SVG render failed, retrying with simplified prompt');

        // Retry once with a stricter prompt
        const retryPrompt =
          `Generate a simple SVG avatar: ${description.trim()}\n\n` +
          'STRICT requirements:\n' +
          '- Output ONLY valid SVG code, nothing else\n' +
          '- viewBox="0 0 512 512", width="512", height="512"\n' +
          '- Use ONLY: circle, rect, ellipse, path, polygon, line, g, defs, linearGradient, radialGradient, stop\n' +
          '- NEVER duplicate attributes on the same element\n' +
          '- NEVER use filters, masks, clipPath, text, or foreignObject\n' +
          '- Keep it simple: fewer than 30 elements total\n' +
          '- Use a solid colored circular background\n' +
          '- Cute, friendly cartoon style';

        const retryText = await generateSvg(provider, retryPrompt);
        const retrySvg = retryText ? extractSvg(retryText) : null;
        if (!retrySvg) {
          return {
            content: `Avatar generation failed: SVG rendering error (${renderMsg}). Please try again.`,
            isError: true,
          };
        }

        pngBuffer = await sharp(Buffer.from(sanitizeSvg(retrySvg)))
          .resize(1024, 1024)
          .png()
          .toBuffer();
      }

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

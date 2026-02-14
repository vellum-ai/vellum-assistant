import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../../config/loader.js';
import { getLogger } from '../../util/logger.js';
import { getApp, updateApp } from '../../memory/app-store.js';

const log = getLogger('app-icon-generator');

async function generateAppIcon(name: string, description?: string): Promise<string> {
  const config = getConfig();
  const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('No Anthropic API key available for icon generation');
  }

  const client = new Anthropic({ apiKey });
  const descPart = description ? `\nDescription: ${description}` : '';
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: 'You are a pixel art icon designer. Return ONLY a single <svg> element — no explanation, no markdown, no code fences. The SVG must be a 16x16 grid pixel art icon using <rect> elements. Use a limited palette (3-5 colors). Keep it under 2KB. The viewBox should be "0 0 16 16" with each pixel being a 1x1 rect.',
    messages: [{
      role: 'user',
      content: `Create a 16x16 pixel art SVG icon representing this app:\nName: ${name}${descPart}`,
    }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const svgMatch = text.match(/<svg[\s\S]*<\/svg>/i);
  if (!svgMatch) {
    throw new Error('No <svg> element found in response');
  }

  return svgMatch[0];
}

export function readCachedAppIcon(appId: string): string | undefined {
  const app = getApp(appId);
  return app?.icon ?? undefined;
}

export async function ensureAppIcon(appId: string, name: string, description?: string): Promise<string | undefined> {
  const app = getApp(appId);
  if (!app) {
    log.warn({ appId }, 'App not found when ensuring icon');
    return undefined;
  }

  if (app.icon) {
    return app.icon;
  }

  try {
    const svg = await generateAppIcon(name, description);
    try {
      updateApp(appId, { icon: svg });
      log.info({ appId }, 'Generated and cached app icon');
    } catch (writeErr) {
      log.warn({ err: writeErr, appId }, 'Failed to cache app icon (returning generated icon anyway)');
    }
    return svg;
  } catch (err) {
    log.warn({ err, appId }, 'Failed to generate app icon');
    return undefined;
  }
}

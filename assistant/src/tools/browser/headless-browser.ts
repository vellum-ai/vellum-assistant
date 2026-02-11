import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { getLogger } from '../../util/logger.js';
import {
  parseUrl,
  isPrivateOrLocalHost,
  resolveHostAddresses,
  resolveRequestAddress,
  sanitizeUrlForOutput,
} from '../network/url-safety.js';
import { browserManager } from './browser-manager.js';

const log = getLogger('headless-browser');

const NAVIGATE_TIMEOUT_MS = 30_000;

async function executeBrowserNavigate(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedUrl = parseUrl(input.url);
  if (!parsedUrl) {
    return { content: 'Error: url is required and must be a valid HTTP(S) URL', isError: true };
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { content: 'Error: url must use http or https', isError: true };
  }

  const allowPrivateNetwork = input.allow_private_network === true;
  const safeRequestedUrl = sanitizeUrlForOutput(parsedUrl);

  // Block private/local targets by default
  if (!allowPrivateNetwork && isPrivateOrLocalHost(parsedUrl.hostname)) {
    return {
      content: `Error: Refusing to navigate to local/private network target (${parsedUrl.hostname}). Set allow_private_network=true if you explicitly need it.`,
      isError: true,
    };
  }

  // DNS resolution check for non-literal hostnames
  if (!allowPrivateNetwork) {
    const resolution = await resolveRequestAddress(
      parsedUrl.hostname,
      resolveHostAddresses,
      allowPrivateNetwork,
    );
    if (resolution.blockedAddress) {
      return {
        content: `Error: Refusing to navigate to target (${parsedUrl.hostname}) because it resolves to local/private network address ${resolution.blockedAddress}. Set allow_private_network=true if you explicitly need it.`,
        isError: true,
      };
    }
  }

  try {
    const page = await browserManager.getOrCreateSessionPage(context.sessionId);
    log.debug({ url: safeRequestedUrl, sessionId: context.sessionId }, 'Navigating');

    const response = await page.goto(parsedUrl.href, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATE_TIMEOUT_MS,
    });

    const finalUrl = page.url();
    const title = await page.title();
    const status = response?.status() ?? null;

    const lines: string[] = [
      `Requested URL: ${safeRequestedUrl}`,
      `Final URL: ${finalUrl}`,
      `Status: ${status ?? 'unknown'}`,
      `Title: ${title || '(none)'}`,
    ];

    if (finalUrl !== parsedUrl.href) {
      lines.push(`Note: Page redirected from the requested URL.`);
    }

    return { content: lines.join('\n'), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, url: safeRequestedUrl }, 'Navigation failed');
    return { content: `Error: Navigation failed: ${msg}`, isError: true };
  }
}

class BrowserNavigateTool implements Tool {
  name = 'browser_navigate';
  description = 'Navigate a headless browser to a URL and return the page title and status. Use this to load web pages for inspection or interaction.';
  category = 'browser';
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to navigate to. If scheme is missing, https:// is assumed.',
          },
          allow_private_network: {
            type: 'boolean',
            description: 'If true, allows navigation to localhost/private-network hosts. Disabled by default for SSRF safety.',
          },
        },
        required: ['url'],
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeBrowserNavigate(input, context);
  }
}

registerTool(new BrowserNavigateTool());

export { executeBrowserNavigate };

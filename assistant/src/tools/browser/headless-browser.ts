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

// ── browser_snapshot ─────────────────────────────────────────────────

const MAX_SNAPSHOT_ELEMENTS = 500;

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[contenteditable="true"]',
].join(', ');

type SnapshotElement = {
  eid: string;
  tag: string;
  attrs: Record<string, string>;
  text: string;
};

async function executeBrowserSnapshot(
  _input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const page = await browserManager.getOrCreateSessionPage(context.sessionId);
    const currentUrl = page.url();
    const title = await page.title();

    const elements = (await page.evaluate(`
      (() => {
        const SELECTOR = ${JSON.stringify(INTERACTIVE_SELECTOR)};
        const MAX = ${MAX_SNAPSHOT_ELEMENTS};
        const els = Array.from(document.querySelectorAll(SELECTOR));
        const visible = els.filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        return visible.slice(0, MAX).map((el, i) => {
          const eid = 'e' + (i + 1);
          el.setAttribute('data-vellum-eid', eid);
          const tag = el.tagName.toLowerCase();
          const attrs = {};
          for (const attr of ['type', 'name', 'placeholder', 'href', 'value', 'role', 'aria-label', 'id']) {
            if (el.hasAttribute(attr)) attrs[attr] = el.getAttribute(attr);
          }
          const text = (el.textContent || '').trim().slice(0, 80);
          return { eid, tag, attrs, text };
        });
      })()
    `)) as SnapshotElement[];

    // Build and store selector map
    const selectorMap = new Map<string, string>();
    for (const el of elements) {
      selectorMap.set(el.eid, `[data-vellum-eid="${el.eid}"]`);
    }
    browserManager.storeSnapshotMap(context.sessionId, selectorMap);

    // Format output
    const lines: string[] = [
      `URL: ${currentUrl}`,
      `Title: ${title || '(none)'}`,
      '',
    ];

    if (elements.length === 0) {
      lines.push('(no interactive elements found)');
    } else {
      for (const el of elements) {
        let desc = `<${el.tag}`;
        for (const [key, val] of Object.entries(el.attrs)) {
          desc += ` ${key}="${val}"`;
        }
        desc += '>';
        if (el.text) {
          desc += ` ${el.text}`;
        }
        lines.push(`[${el.eid}] ${desc}`);
      }
      lines.push('');
      lines.push(`${elements.length} interactive element${elements.length === 1 ? '' : 's'} found.`);
    }

    return { content: lines.join('\n'), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Snapshot failed');
    return { content: `Error: Snapshot failed: ${msg}`, isError: true };
  }
}

class BrowserSnapshotTool implements Tool {
  name = 'browser_snapshot';
  description = 'List interactive elements on the current page. Returns elements with unique IDs that can be used with browser_click and browser_type.';
  category = 'browser';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {},
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeBrowserSnapshot(input, context);
  }
}

registerTool(new BrowserSnapshotTool());

// ── browser_close ────────────────────────────────────────────────────

async function executeBrowserClose(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    if (input.close_all_pages === true) {
      await browserManager.closeAllPages();
      return { content: 'All browser pages and context closed.', isError: false };
    }
    await browserManager.closeSessionPage(context.sessionId);
    return { content: 'Browser page closed for this session.', isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Close failed');
    return { content: `Error: Close failed: ${msg}`, isError: true };
  }
}

class BrowserCloseTool implements Tool {
  name = 'browser_close';
  description = 'Close the browser page for the current session, or all pages if close_all_pages is true.';
  category = 'browser';
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          close_all_pages: {
            type: 'boolean',
            description: 'If true, close all browser pages and the browser context. Default: false (close only the current session page).',
          },
        },
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeBrowserClose(input, context);
  }
}

registerTool(new BrowserCloseTool());

export { executeBrowserNavigate, executeBrowserSnapshot, executeBrowserClose };

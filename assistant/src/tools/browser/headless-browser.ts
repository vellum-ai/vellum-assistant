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
import type { RouteHandler } from './browser-manager.js';

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

  let routeHandler: RouteHandler | null = null;

  try {
    const page = await browserManager.getOrCreateSessionPage(context.sessionId);
    log.debug({ url: safeRequestedUrl, sessionId: context.sessionId }, 'Navigating');

    // Install request interception to block redirects/sub-requests to private networks.
    // This prevents SSRF bypass via server-side redirects and DNS rebinding attacks,
    // since Playwright follows redirects internally and performs its own DNS resolution.
    let blockedUrl: string | null = null;
    if (!allowPrivateNetwork) {
      routeHandler = async (route, request) => {
        const reqUrl = request.url();
        let reqParsed: URL;
        try {
          reqParsed = new URL(reqUrl);
        } catch {
          await route.continue();
          return;
        }

        // Check hostname against private/local patterns
        if (isPrivateOrLocalHost(reqParsed.hostname)) {
          blockedUrl = sanitizeUrlForOutput(reqParsed);
          log.warn({ blockedUrl }, 'Blocked navigation to private network target via redirect');
          await route.abort('blockedbyclient');
          return;
        }

        // Resolve DNS and check resolved addresses
        const resolution = await resolveRequestAddress(
          reqParsed.hostname,
          resolveHostAddresses,
          false,
        );
        if (resolution.blockedAddress) {
          blockedUrl = sanitizeUrlForOutput(reqParsed);
          log.warn({ blockedUrl, resolvedTo: resolution.blockedAddress }, 'Blocked navigation: DNS resolves to private address');
          await route.abort('blockedbyclient');
          return;
        }

        await route.continue();
      };
      await page.route('**/*', routeHandler);
    }

    const response = await page.goto(parsedUrl.href, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATE_TIMEOUT_MS,
    });

    // Remove the route handler now that navigation is complete
    if (routeHandler) {
      await page.unroute('**/*', routeHandler);
      routeHandler = null;
    }

    if (blockedUrl) {
      return {
        content: `Error: Navigation blocked. A request targeted a local/private network address (${blockedUrl}). Set allow_private_network=true if you explicitly need it.`,
        isError: true,
      };
    }

    const finalUrl = page.url();
    const safeFinalUrl = sanitizeUrlForOutput(new URL(finalUrl));
    const title = await page.title();
    const status = response?.status() ?? null;

    const lines: string[] = [
      `Requested URL: ${safeRequestedUrl}`,
      `Final URL: ${safeFinalUrl}`,
      `Status: ${status ?? 'unknown'}`,
      `Title: ${title || '(none)'}`,
    ];

    if (finalUrl !== parsedUrl.href) {
      lines.push(`Note: Page redirected from the requested URL.`);
    }

    return { content: lines.join('\n'), isError: false };
  } catch (err) {
    // Best-effort cleanup of route handler on error
    if (routeHandler) {
      try {
        const page = await browserManager.getOrCreateSessionPage(context.sessionId);
        await page.unroute('**/*', routeHandler);
      } catch { /* ignore cleanup errors */ }
    }
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

// ── shared element resolution ────────────────────────────────────────

function resolveSelector(
  sessionId: string,
  input: Record<string, unknown>,
): { selector: string | null; error: string | null } {
  const elementId = typeof input.element_id === 'string' ? input.element_id : null;
  const rawSelector = typeof input.selector === 'string' ? input.selector : null;

  if (!elementId && !rawSelector) {
    return { selector: null, error: 'Error: Either element_id or selector is required.' };
  }

  if (elementId) {
    const resolved = browserManager.resolveSnapshotSelector(sessionId, elementId);
    if (!resolved) {
      return {
        selector: null,
        error: `Error: element_id "${elementId}" not found. Run browser_snapshot first to get current element IDs.`,
      };
    }
    return { selector: resolved, error: null };
  }

  return { selector: rawSelector!, error: null };
}

// ── browser_click ────────────────────────────────────────────────────

async function executeBrowserClick(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const { selector, error } = resolveSelector(context.sessionId, input);
  if (error) return { content: error, isError: true };

  try {
    const page = await browserManager.getOrCreateSessionPage(context.sessionId);
    await page.click(selector!);
    return { content: `Clicked element: ${selector}`, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, selector }, 'Click failed');
    return { content: `Error: Click failed: ${msg}`, isError: true };
  }
}

class BrowserClickTool implements Tool {
  name = 'browser_click';
  description = 'Click an element on the page. Target the element by element_id (from browser_snapshot) or a CSS selector.';
  category = 'browser';
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          element_id: {
            type: 'string',
            description: 'The element ID from a previous browser_snapshot result (e.g. "e1").',
          },
          selector: {
            type: 'string',
            description: 'A CSS selector to target. Used as fallback when element_id is not available.',
          },
        },
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeBrowserClick(input, context);
  }
}

registerTool(new BrowserClickTool());

// ── browser_type ─────────────────────────────────────────────────────

async function executeBrowserType(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const { selector, error } = resolveSelector(context.sessionId, input);
  if (error) return { content: error, isError: true };

  const text = typeof input.text === 'string' ? input.text : '';
  if (!text) {
    return { content: 'Error: text is required.', isError: true };
  }

  const clearFirst = input.clear_first !== false; // default true
  const pressEnter = input.press_enter === true;

  try {
    const page = await browserManager.getOrCreateSessionPage(context.sessionId);

    if (clearFirst) {
      await page.fill(selector!, text);
    } else {
      const currentValue = (await page.evaluate(
        `document.querySelector(${JSON.stringify(selector!)})?.value ?? ''`,
      )) as string;
      await page.fill(selector!, currentValue + text);
    }

    if (pressEnter) {
      await page.press(selector!, 'Enter');
    }

    const lines = [`Typed into element: ${selector}`];
    if (clearFirst) lines.push('(cleared existing content first)');
    if (pressEnter) lines.push('(pressed Enter after typing)');
    return { content: lines.join('\n'), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, selector }, 'Type failed');
    return { content: `Error: Type failed: ${msg}`, isError: true };
  }
}

class BrowserTypeTool implements Tool {
  name = 'browser_type';
  description = 'Type text into an input element. Target by element_id (from browser_snapshot) or CSS selector.';
  category = 'browser';
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          element_id: {
            type: 'string',
            description: 'The element ID from a previous browser_snapshot result (e.g. "e3").',
          },
          selector: {
            type: 'string',
            description: 'A CSS selector to target. Used as fallback when element_id is not available.',
          },
          text: {
            type: 'string',
            description: 'The text to type into the element.',
          },
          clear_first: {
            type: 'boolean',
            description: 'If true (default), clear existing content before typing. Set to false to append.',
          },
          press_enter: {
            type: 'boolean',
            description: 'If true, press Enter after typing the text.',
          },
        },
        required: ['text'],
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeBrowserType(input, context);
  }
}

registerTool(new BrowserTypeTool());

// ── browser_press_key ────────────────────────────────────────────────

async function executeBrowserPressKey(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const key = typeof input.key === 'string' ? input.key : '';
  if (!key) {
    return { content: 'Error: key is required.', isError: true };
  }

  try {
    const page = await browserManager.getOrCreateSessionPage(context.sessionId);

    // If element_id or selector is provided, press key on that element
    const elementId = typeof input.element_id === 'string' ? input.element_id : null;
    const rawSelector = typeof input.selector === 'string' ? input.selector : null;

    if (elementId || rawSelector) {
      const { selector, error } = resolveSelector(context.sessionId, input);
      if (error) return { content: error, isError: true };
      await page.press(selector!, key);
      return { content: `Pressed "${key}" on element: ${selector}`, isError: false };
    }

    // No target → press key on the page (focused element)
    await page.keyboard.press(key);
    return { content: `Pressed "${key}"`, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, key }, 'Press key failed');
    return { content: `Error: Press key failed: ${msg}`, isError: true };
  }
}

class BrowserPressKeyTool implements Tool {
  name = 'browser_press_key';
  description = 'Press a keyboard key, optionally targeting a specific element. Use for Enter, Escape, Tab, arrow keys, etc.';
  category = 'browser';
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'The key to press (e.g. "Enter", "Escape", "Tab", "ArrowDown", "a").',
          },
          element_id: {
            type: 'string',
            description: 'Optional element ID from browser_snapshot to target.',
          },
          selector: {
            type: 'string',
            description: 'Optional CSS selector to target.',
          },
        },
        required: ['key'],
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeBrowserPressKey(input, context);
  }
}

registerTool(new BrowserPressKeyTool());

// ── browser_wait_for ─────────────────────────────────────────────────

const MAX_WAIT_MS = 30_000;

async function executeBrowserWaitFor(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const selector = typeof input.selector === 'string' && input.selector ? input.selector : null;
  const text = typeof input.text === 'string' && input.text ? input.text : null;
  const duration = typeof input.duration === 'number' ? input.duration : null;

  const modeCount = [selector, text, duration].filter((v) => v !== null).length;
  if (modeCount === 0) {
    return { content: 'Error: Exactly one of selector, text, or duration is required.', isError: true };
  }
  if (modeCount > 1) {
    return { content: 'Error: Provide exactly one of selector, text, or duration (not multiple).', isError: true };
  }

  const timeout = typeof input.timeout === 'number'
    ? Math.min(input.timeout, MAX_WAIT_MS)
    : MAX_WAIT_MS;

  try {
    const page = await browserManager.getOrCreateSessionPage(context.sessionId);

    if (selector) {
      await page.waitForSelector(selector, { timeout });
      return { content: `Element matching "${selector}" appeared.`, isError: false };
    }

    if (text) {
      const escaped = JSON.stringify(text);
      await page.waitForFunction(
        `document.body?.innerText?.includes(${escaped})`,
        { timeout },
      );
      return { content: `Text "${text.slice(0, 80)}" appeared on page.`, isError: false };
    }

    // duration mode (milliseconds)
    const waitMs = Math.min(duration!, MAX_WAIT_MS);
    await new Promise((r) => setTimeout(r, waitMs));
    return { content: `Waited ${waitMs}ms.`, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Wait failed');
    return { content: `Error: Wait failed: ${msg}`, isError: true };
  }
}

class BrowserWaitForTool implements Tool {
  name = 'browser_wait_for';
  description = 'Wait for a condition: a CSS selector to appear, text to appear on the page, or a fixed duration in milliseconds. Provide exactly one mode.';
  category = 'browser';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'Wait for an element matching this CSS selector to appear.',
          },
          text: {
            type: 'string',
            description: 'Wait for this text to appear on the page.',
          },
          duration: {
            type: 'number',
            description: 'Wait for this many milliseconds.',
          },
          timeout: {
            type: 'number',
            description: 'Maximum wait time in milliseconds (default and max: 30000).',
          },
        },
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeBrowserWaitFor(input, context);
  }
}

registerTool(new BrowserWaitForTool());

// ── browser_extract ──────────────────────────────────────────────────

const MAX_EXTRACT_LENGTH = 50_000;

async function executeBrowserExtract(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const includeLinks = input.include_links === true;

  try {
    const page = await browserManager.getOrCreateSessionPage(context.sessionId);
    const currentUrl = page.url();
    const title = await page.title();

    let textContent = (await page.evaluate(
      `document.body?.innerText ?? ''`,
    )) as string;

    if (textContent.length > MAX_EXTRACT_LENGTH) {
      textContent = textContent.slice(0, MAX_EXTRACT_LENGTH) + '\n... (truncated)';
    }

    const lines: string[] = [
      `URL: ${currentUrl}`,
      `Title: ${title || '(none)'}`,
      '',
      textContent || '(empty page)',
    ];

    if (includeLinks) {
      const links = (await page.evaluate(`
        (() => {
          const anchors = Array.from(document.querySelectorAll('a[href]'));
          return anchors.slice(0, 200).map(a => ({
            text: (a.textContent || '').trim().slice(0, 80),
            href: a.href,
          }));
        })()
      `)) as Array<{ text: string; href: string }>;

      if (links.length > 0) {
        lines.push('');
        lines.push('Links:');
        for (const link of links) {
          lines.push(`  [${link.text || '(no text)'}](${link.href})`);
        }
      }
    }

    return { content: lines.join('\n'), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Extract failed');
    return { content: `Error: Extract failed: ${msg}`, isError: true };
  }
}

class BrowserExtractTool implements Tool {
  name = 'browser_extract';
  description = 'Extract the text content of the current page. Optionally include links. Output is capped to prevent excessive token usage.';
  category = 'browser';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          include_links: {
            type: 'boolean',
            description: 'If true, include a list of links found on the page (up to 200).',
          },
        },
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeBrowserExtract(input, context);
  }
}

registerTool(new BrowserExtractTool());

export {
  executeBrowserNavigate,
  executeBrowserSnapshot,
  executeBrowserClose,
  executeBrowserClick,
  executeBrowserType,
  executeBrowserPressKey,
  executeBrowserWaitFor,
  executeBrowserExtract,
};

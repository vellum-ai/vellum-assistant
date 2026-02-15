/**
 * Runtime message-injection helpers extracted from Session.
 *
 * These functions modify the user-message tail of the conversation
 * before it is sent to the provider.  They are pure (no side effects).
 */

import type { Message } from '../providers/types.js';

/**
 * Describes the capabilities of the channel through which the user is
 * interacting.  Used to gate UI-specific references and permission asks.
 */
export interface ChannelCapabilities {
  /** The raw channel identifier (e.g. "dashboard", "telegram", "http-api"). */
  channel: string;
  /** Whether this channel can render the dashboard UI (apps, dynamic pages). */
  dashboardCapable: boolean;
  /** Whether the channel supports dynamic UI surfaces (ui_show / ui_update). */
  supportsDynamicUi: boolean;
  /** Whether the channel supports voice/microphone input. */
  supportsVoiceInput: boolean;
}

/** Derive channel capabilities from a raw source channel identifier. */
export function resolveChannelCapabilities(sourceChannel?: string | null): ChannelCapabilities {
  const channel = sourceChannel ?? 'dashboard';
  const isDashboard = channel === 'dashboard';
  return {
    channel,
    dashboardCapable: isDashboard,
    supportsDynamicUi: isDashboard,
    supportsVoiceInput: isDashboard,
  };
}

/** Context about the active workspace surface, passed to applyRuntimeInjections. */
export interface ActiveSurfaceContext {
  surfaceId: string;
  html: string;
  /** When set, the surface is backed by a persisted app. */
  appId?: string;
  appName?: string;
  appSchemaJson?: string;
  /** Additional pages keyed by filename (e.g. "settings.html" → HTML content). */
  appPages?: Record<string, string>;
  /** The page currently displayed in the WebView (e.g. "settings.html"). */
  currentPage?: string;
}

/**
 * Append a memory-conflict clarification instruction to the last user message.
 */
export function injectClarificationRequestIntoUserMessage(message: Message, question: string): Message {
  const instruction = [
    '[Memory clarification request]',
    `Ask this once in your response: ${question}`,
    'After asking, continue helping with the current request.',
  ].join('\n');
  return {
    ...message,
    content: [
      ...message.content,
      { type: 'text', text: `\n\n${instruction}` },
    ],
  };
}

const MAX_CONTEXT_LENGTH = 100_000;

function truncateHtml(html: string, budget: number): string {
  if (html.length <= budget) return html;
  return html.slice(0, budget) + `\n<!-- truncated: original is ${html.length} characters -->`;
}

/**
 * Prepend workspace context so the model can refine UI surfaces.
 * Adapts the injected rules based on whether the surface is app-backed.
 */
export function injectActiveSurfaceContext(message: Message, ctx: ActiveSurfaceContext): Message {
  const lines: string[] = ['<active_workspace>'];

  if (ctx.appId) {
    // ── App-backed surface ──
    lines.push(
      `The user is viewing app "${ctx.appName ?? 'Untitled'}" (app_id: "${ctx.appId}") in workspace mode.`,
      '',
      'RULES FOR WORKSPACE MODIFICATION:',
      `1. Call \`app_update\` with app_id "${ctx.appId}" and the updated \`html\` to apply changes.`,
      '   The surface refreshes automatically — do NOT call ui_show or ui_update.',
      '2. You MAY call other tools first to gather data (get_weather, web_search, etc.)',
      '   before calling app_update.',
      '3. Make ONLY the changes the user requested. Preserve all existing content,',
      '   styling, and functionality unless explicitly asked to change them.',
      '4. When adding new content, match the existing visual style.',
      '5. Keep your text response to 1 brief sentence confirming what you changed.',
    );

    // App structure metadata
    lines.push('', 'App structure:');
    const pageNames = ctx.appPages ? Object.keys(ctx.appPages) : [];
    const viewingPage = ctx.currentPage && ctx.currentPage !== 'index.html' ? ctx.currentPage : null;

    if (viewingPage) {
      lines.push(`- Currently viewing: ${viewingPage}`);
    }
    lines.push(`- Main page (index.html)${viewingPage ? '' : ': shown below'}`);
    if (pageNames.length > 0) {
      lines.push(`- Additional pages: ${pageNames.join(', ')}`);
      lines.push('  To modify additional pages, include the `pages` parameter in `app_update`.');
      lines.push('  IMPORTANT: The `pages` parameter is a full replacement — always include ALL');
      lines.push('  existing pages (with their current content) alongside any modified or new pages.');
    } else {
      lines.push('- Additional pages: none');
    }
    const schema = ctx.appSchemaJson;
    const MAX_SCHEMA_LENGTH = 10_000;
    if (schema && schema !== '"{}"' && schema !== '{}') {
      const truncatedSchema = schema.length > MAX_SCHEMA_LENGTH
        ? schema.slice(0, MAX_SCHEMA_LENGTH) + '… (truncated)'
        : schema;
      lines.push(`- Data schema: ${truncatedSchema}`);
    } else {
      lines.push('- Data schema: none (display-only)');
    }

    // Determine which HTML to show as primary based on the currently viewed page
    let primaryLabel = 'index.html';
    let primaryHtml = ctx.html;
    if (viewingPage && ctx.appPages?.[viewingPage]) {
      primaryLabel = viewingPage;
      primaryHtml = ctx.appPages[viewingPage];
    }

    // Primary page HTML — reserve budget for additional pages (and schema)
    const schemaSize = schema ? Math.min(schema.length, MAX_SCHEMA_LENGTH) : 0;
    let mainBudget = MAX_CONTEXT_LENGTH - schemaSize;
    const additionalPageBlocks: string[] = [];

    // Build additional page content (all pages except the primary one)
    const otherPages: Record<string, string> = {};
    if (viewingPage && primaryLabel !== 'index.html') {
      // Show index.html as additional context
      otherPages['index.html'] = ctx.html;
    }
    if (ctx.appPages) {
      for (const [filename, content] of Object.entries(ctx.appPages)) {
        if (filename !== primaryLabel) {
          otherPages[filename] = content;
        }
      }
    }

    if (Object.keys(otherPages).length > 0) {
      let additionalSize = 0;
      for (const [filename, content] of Object.entries(otherPages)) {
        additionalSize += filename.length + content.length + 30;
        additionalPageBlocks.push(`--- ${filename} ---`, content);
      }
      if (additionalSize + primaryHtml.length > MAX_CONTEXT_LENGTH - schemaSize) {
        additionalPageBlocks.length = 0;
      } else {
        mainBudget = MAX_CONTEXT_LENGTH - schemaSize - additionalSize;
      }
    }

    lines.push('', `Current HTML (${primaryLabel}):`, truncateHtml(primaryHtml, mainBudget));

    if (additionalPageBlocks.length > 0) {
      lines.push('', 'Additional page content:', ...additionalPageBlocks);
    }
  } else {
    // ── Ephemeral surface (created via ui_show, no persisted app) ──
    lines.push(
      `The user is viewing a dynamic page (surface_id: "${ctx.surfaceId}") in workspace mode.`,
      '',
      'RULES FOR WORKSPACE MODIFICATION:',
      `1. Call \`ui_update\` with surface_id "${ctx.surfaceId}" and data.html containing`,
      '   the complete updated HTML.',
      '2. You MAY call other tools first to gather data before calling ui_update.',
      '3. Do NOT call ui_show — modify the existing page.',
      '4. Make ONLY the changes the user requested. Preserve all existing content,',
      '   styling, and functionality unless explicitly asked to change them.',
      '5. Keep your text response to 1 brief sentence confirming what you changed.',
      '',
      'Current HTML:',
      truncateHtml(ctx.html, MAX_CONTEXT_LENGTH),
    );
  }

  lines.push('</active_workspace>');

  const block = lines.join('\n');
  return {
    ...message,
    content: [
      { type: 'text', text: block },
      ...message.content,
    ],
  };
}

/**
 * Prepend channel capability context to the last user message so the
 * model knows what the current channel can and cannot do.
 */
export function injectChannelCapabilityContext(message: Message, caps: ChannelCapabilities): Message {
  const lines: string[] = ['<channel_capabilities>'];
  lines.push(`channel: ${caps.channel}`);
  lines.push(`dashboard_capable: ${caps.dashboardCapable}`);
  lines.push(`supports_dynamic_ui: ${caps.supportsDynamicUi}`);
  lines.push(`supports_voice_input: ${caps.supportsVoiceInput}`);

  if (!caps.dashboardCapable) {
    lines.push('');
    lines.push('CHANNEL CONSTRAINTS:');
    lines.push('- Do NOT reference the dashboard UI, settings panels, or visual preference pickers.');
    lines.push('- Do NOT use ui_show, ui_update, or app_create — this channel cannot render them.');
    lines.push('- Present information as well-formatted text instead of dynamic UI.');
    lines.push('- Defer dashboard-specific actions (e.g. accent color selection) by telling the user');
    lines.push('  they can complete those steps later from the desktop app.');
  }

  if (!caps.supportsVoiceInput) {
    lines.push('- Do NOT ask the user to use voice or microphone input.');
  }

  lines.push('</channel_capabilities>');

  const block = lines.join('\n');
  return {
    ...message,
    content: [
      { type: 'text', text: block },
      ...message.content,
    ],
  };
}

/**
 * Strip `<channel_capabilities>` blocks injected by
 * `injectChannelCapabilityContext`.
 */
export function stripChannelCapabilityContext(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'user') return message;
    const nextContent = message.content.filter((block) => {
      if (block.type !== 'text') return true;
      return !block.text.startsWith('<channel_capabilities>');
    });
    if (nextContent.length === message.content.length) return message;
    if (nextContent.length === 0) return null;
    return { ...message, content: nextContent };
  }).filter((message): message is NonNullable<typeof message> => message !== null);
}

/**
 * Strip `<active_workspace>` (and legacy `<active_dynamic_page>`) blocks
 * injected by `injectActiveSurfaceContext`.  Called after the agent run to
 * prevent the (potentially 100 KB) surface HTML from persisting in session
 * history.
 */
export function stripActiveSurfaceContext(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'user') return message;
    const nextContent = message.content.filter((block) => {
      if (block.type !== 'text') return true;
      return !block.text.startsWith('<active_workspace>') && !block.text.startsWith('<active_dynamic_page>');
    });
    if (nextContent.length === message.content.length) return message;
    if (nextContent.length === 0) return null;
    return { ...message, content: nextContent };
  }).filter((message): message is NonNullable<typeof message> => message !== null);
}

/**
 * Apply a chain of user-message injections to `runMessages`.
 *
 * Each injection is optional — pass `null`/`undefined` to skip it.
 * Returns the final message array ready for the provider.
 */
export function applyRuntimeInjections(
  runMessages: Message[],
  options: {
    softConflictInstruction?: string | null;
    activeSurface?: ActiveSurfaceContext | null;
    channelCapabilities?: ChannelCapabilities | null;
  },
): Message[] {
  let result = runMessages;

  if (options.softConflictInstruction) {
    const userTail = result[result.length - 1];
    if (userTail && userTail.role === 'user') {
      result = [
        ...result.slice(0, -1),
        injectClarificationRequestIntoUserMessage(userTail, options.softConflictInstruction),
      ];
    }
  }

  if (options.activeSurface) {
    const userTail = result[result.length - 1];
    if (userTail && userTail.role === 'user') {
      result = [
        ...result.slice(0, -1),
        injectActiveSurfaceContext(userTail, options.activeSurface),
      ];
    }
  }

  if (options.channelCapabilities) {
    const userTail = result[result.length - 1];
    if (userTail && userTail.role === 'user') {
      result = [
        ...result.slice(0, -1),
        injectChannelCapabilityContext(userTail, options.channelCapabilities),
      ];
    }
  }

  return result;
}

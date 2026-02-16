/**
 * Runtime message-injection helpers extracted from Session.
 *
 * These functions modify the user-message tail of the conversation
 * before it is sent to the provider.  They are pure (no side effects).
 */

import type { Message } from '../providers/types.js';
import { listAppFiles, getAppsDir } from '../memory/app-store.js';
import { statSync } from 'node:fs';
import { join } from 'node:path';

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
  /** Pre-fetched list of files in the app directory. */
  appFiles?: string[];
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
      `1. Use \`app_file_edit\` with app_id "${ctx.appId}" for surgical changes.`,
      '   Provide old_string (exact match) and new_string (replacement).',
      '   Include a short `status` message describing what you\'re doing (e.g. "adding dark mode styles").',
      '2. Use `app_file_write` to create new files or fully rewrite files. Include `status`.',
      '3. Use `app_file_read` to read any file with line numbers before editing.',
      '4. Use `app_file_list` to see all files in the app.',
      '5. The surface refreshes automatically after file edits — do NOT call app_update, ui_show, or ui_update.',
      '6. NEVER respond with only text — the user expects a visual update.',
      '7. Make ONLY the changes the user requested. Preserve existing content/styling.',
      '8. Keep your text response to 1 brief sentence confirming what you changed.',
    );

    if (ctx.html.includes('data-vellum-home-base="v1"')) {
      lines.push(
        '6. This is the prebuilt Home Base scaffold. Preserve layout anchors:',
        '   `home-base-root`, `home-base-onboarding-lane`, and `home-base-starter-lane`.',
      );
    }

    // File tree with sizes (capped at 50 files to bound prompt size)
    const files = ctx.appFiles ?? listAppFiles(ctx.appId);
    const MAX_FILE_TREE_ENTRIES = 50;
    const displayFiles = files.slice(0, MAX_FILE_TREE_ENTRIES);
    lines.push('', 'App files:');
    for (const filePath of displayFiles) {
      let sizeLabel: string;
      try {
        const bytes = statSync(join(getAppsDir(), ctx.appId, filePath)).size;
        sizeLabel = bytes < 1000 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
      } catch {
        sizeLabel = '? KB';
      }
      lines.push(`  ${filePath} (${sizeLabel})`);
    }
    if (files.length > MAX_FILE_TREE_ENTRIES) {
      lines.push(`  ... and ${files.length - MAX_FILE_TREE_ENTRIES} more files`);
    }

    // Schema metadata
    const schema = ctx.appSchemaJson;
    const MAX_SCHEMA_LENGTH = 10_000;
    if (schema && schema !== '"{}"' && schema !== '{}') {
      const truncatedSchema = schema.length > MAX_SCHEMA_LENGTH
        ? schema.slice(0, MAX_SCHEMA_LENGTH) + '… (truncated)'
        : schema;
      lines.push('', `Data schema: ${truncatedSchema}`);
    }

    // Determine which file content to show based on the currently viewed page
    const viewingPage = ctx.currentPage && ctx.currentPage !== 'index.html' ? ctx.currentPage : null;
    let primaryLabel = 'index.html';
    let primaryContent = ctx.html;
    if (viewingPage && ctx.appPages?.[viewingPage]) {
      primaryLabel = viewingPage;
      primaryContent = ctx.appPages[viewingPage];
    }

    // Line-numbered current file content
    const schemaSize = schema ? Math.min(schema.length, MAX_SCHEMA_LENGTH) : 0;
    // Reduce budget by 15% to account for line-number prefix overhead (~7 chars/line)
    let mainBudget = Math.floor((MAX_CONTEXT_LENGTH - schemaSize) * 0.85);
    const additionalPageBlocks: string[] = [];

    // Build additional page content (all pages except the primary one)
    const otherPages: Record<string, string> = {};
    if (viewingPage && primaryLabel !== 'index.html') {
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
      if (additionalSize + primaryContent.length > MAX_CONTEXT_LENGTH - schemaSize) {
        additionalPageBlocks.length = 0;
      } else {
        mainBudget = Math.floor((MAX_CONTEXT_LENGTH - schemaSize - additionalSize) * 0.85);
      }
    }

    // Format file content with line numbers (cat -n style)
    const truncatedContent = truncateHtml(primaryContent, mainBudget);
    const numberedLines = truncatedContent.split('\n').map((line, i) => {
      const num = String(i + 1);
      return `${num.padStart(6)}\t${line}`;
    }).join('\n');
    lines.push('', `--- ${primaryLabel} ---`, numberedLines);

    if (additionalPageBlocks.length > 0) {
      lines.push('', 'Additional page content:', ...additionalPageBlocks);
    }
  } else {
    // ── Ephemeral surface (created via ui_show, no persisted app) ──
    lines.push(
      `The user is viewing a dynamic page (surface_id: "${ctx.surfaceId}") in workspace mode.`,
      '',
      'RULES FOR WORKSPACE MODIFICATION:',
      `1. You MUST call \`ui_update\` with surface_id "${ctx.surfaceId}" and data.html containing`,
      '   the complete updated HTML.',
      '   NEVER respond with only text — the user expects a visual update every time they',
      '   send a message here. Even if the page appears to already show what they want,',
      '   call ui_update anyway (the user sees a broken experience when no update arrives).',
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
 * Prepend workspace top-level directory context to a user message.
 */
export function injectWorkspaceTopLevelContext(message: Message, contextText: string): Message {
  return {
    ...message,
    content: [
      { type: 'text', text: contextText },
      ...message.content,
    ],
  };
}

/**
 * Strip `<workspace_top_level>` blocks injected by
 * `injectWorkspaceTopLevelContext`.  Called after the agent run to prevent
 * workspace context from persisting in session history.
 */
export function stripWorkspaceTopLevelContext(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'user') return message;
    const nextContent = message.content.filter((block) => {
      if (block.type !== 'text') return true;
      return !block.text.startsWith('<workspace_top_level>');
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
    workspaceTopLevelContext?: string | null;
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

  // Workspace top-level context is injected last so it appears first
  // (prepended) in the user message content, keeping cache breakpoints
  // anchored to the trailing blocks.
  if (options.workspaceTopLevelContext) {
    const userTail = result[result.length - 1];
    if (userTail && userTail.role === 'user') {
      result = [
        ...result.slice(0, -1),
        injectWorkspaceTopLevelContext(userTail, options.workspaceTopLevelContext),
      ];
    }
  }

  return result;
}

/**
 * Standalone executor functions for app tool operations.
 *
 * Each executor encapsulates the business logic that was previously inline
 * in the tool definition's execute() handler.  They accept plain typed
 * parameters and return plain result objects, making them reusable from
 * both core tool handlers and skill scripts without depending on
 * ToolDefinition or ToolContext types.
 */

import type { AppDefinition } from '../../memory/app-store.js';
import type { EditEngineResult } from '../../memory/app-store.js';
import { openAppViaSurface } from './open-proxy.js';

// ---------------------------------------------------------------------------
// Shared result type
// ---------------------------------------------------------------------------

export interface ExecutorResult {
  content: string;
  isError: boolean;
  /** Optional status message for display (e.g. progress indicator). */
  status?: string;
}

// ---------------------------------------------------------------------------
// Dependency interfaces — callers inject these rather than importing the
// app-store module directly, which makes the executors testable with mocks.
// ---------------------------------------------------------------------------

export interface AppStoreReader {
  getApp(id: string): AppDefinition | null;
  listApps(): AppDefinition[];
  queryAppRecords(appId: string): unknown[];
  listAppFiles(appId: string): string[];
  readAppFile(appId: string, path: string): string;
}

export interface AppStoreWriter {
  createApp(params: {
    name: string;
    description?: string;
    schemaJson: string;
    htmlDefinition: string;
    pages?: Record<string, string>;
    appType?: 'app' | 'site';
  }): AppDefinition;
  updateApp(
    id: string,
    updates: Partial<Pick<AppDefinition, 'name' | 'description' | 'schemaJson' | 'htmlDefinition' | 'pages'>>,
  ): AppDefinition;
  deleteApp(id: string): void;
  writeAppFile(appId: string, path: string, content: string): void;
  editAppFile(
    appId: string,
    path: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): EditEngineResult;
}

export type AppStore = AppStoreReader & AppStoreWriter;

/**
 * Proxy resolver type matching the shape used by the core tool context.
 * Allows app_create's auto-open behavior to forward to the connected client.
 */
export type ProxyResolver = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<ExecutorResult>;

// ---------------------------------------------------------------------------
// app_create
// ---------------------------------------------------------------------------

export interface AppCreateInput {
  name: string;
  description?: string;
  schema_json?: string;
  html: string;
  pages?: Record<string, string>;
  type?: 'app' | 'site';
  auto_open?: boolean;
  preview?: Record<string, unknown>;
}

export async function executeAppCreate(
  input: AppCreateInput,
  store: AppStore,
  proxyToolResolver?: ProxyResolver,
): Promise<ExecutorResult> {
  const name = input.name;
  const description = input.description;
  const schemaJson = input.schema_json ?? '{}';
  const htmlDefinition = input.html;
  const pages = input.pages;
  const autoOpen = input.auto_open !== false; // default true
  const preview = input.preview;
  const appType = input.type === 'site' ? 'site' as const : 'app' as const;

  const app = store.createApp({ name, description, schemaJson, htmlDefinition, pages, appType });

  // Auto-open the app via the shared open-proxy helper
  if (autoOpen && proxyToolResolver) {
    const extraInput = preview ? { preview } : undefined;
    const openResultText = await openAppViaSurface(app.id, proxyToolResolver, extraInput);

    // Determine whether the open succeeded by checking for the fallback text
    const opened = openResultText !== 'Failed to auto-open app. Use app_open to open it manually.';
    if (opened) {
      return {
        content: JSON.stringify({
          ...app,
          auto_opened: true,
          open_result: openResultText,
        }),
        isError: false,
      };
    }

    return {
      content: JSON.stringify({
        ...app,
        auto_opened: false,
        auto_open_error: openResultText,
      }),
      isError: false,
    };
  }

  return { content: JSON.stringify(app), isError: false };
}

// ---------------------------------------------------------------------------
// app_list
// ---------------------------------------------------------------------------

export function executeAppList(store: AppStoreReader): ExecutorResult {
  const apps = store.listApps().map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    updatedAt: a.updatedAt,
  }));
  return { content: JSON.stringify(apps), isError: false };
}

// ---------------------------------------------------------------------------
// app_query
// ---------------------------------------------------------------------------

export interface AppQueryInput {
  app_id: string;
}

export function executeAppQuery(
  input: AppQueryInput,
  store: AppStoreReader,
): ExecutorResult {
  const records = store.queryAppRecords(input.app_id);
  return { content: JSON.stringify(records), isError: false };
}

// ---------------------------------------------------------------------------
// app_update
// ---------------------------------------------------------------------------

export interface AppUpdateInput {
  app_id: string;
  name?: string;
  description?: string;
  schema_json?: string;
  html?: string;
  pages?: Record<string, string>;
}

export function executeAppUpdate(
  input: AppUpdateInput,
  store: AppStore,
): ExecutorResult {
  const updates: Partial<Pick<AppDefinition, 'name' | 'description' | 'schemaJson' | 'htmlDefinition' | 'pages'>> = {};
  if (typeof input.name === 'string') updates.name = input.name;
  if (typeof input.description === 'string') updates.description = input.description;
  if (typeof input.schema_json === 'string') updates.schemaJson = input.schema_json;
  if (typeof input.html === 'string') updates.htmlDefinition = input.html;
  if (input.pages && typeof input.pages === 'object') updates.pages = input.pages;

  const app = store.updateApp(input.app_id, updates);
  return { content: JSON.stringify(app), isError: false };
}

// ---------------------------------------------------------------------------
// app_delete
// ---------------------------------------------------------------------------

export interface AppDeleteInput {
  app_id: string;
}

export function executeAppDelete(
  input: AppDeleteInput,
  store: AppStore,
): ExecutorResult {
  store.deleteApp(input.app_id);
  return { content: JSON.stringify({ deleted: true, appId: input.app_id }), isError: false };
}

// ---------------------------------------------------------------------------
// app_file_list
// ---------------------------------------------------------------------------

export interface AppFileListInput {
  app_id: string;
}

export function executeAppFileList(
  input: AppFileListInput,
  store: AppStoreReader,
): ExecutorResult {
  const files = store.listAppFiles(input.app_id);
  return { content: JSON.stringify(files), isError: false };
}

// ---------------------------------------------------------------------------
// app_file_read
// ---------------------------------------------------------------------------

export interface AppFileReadInput {
  app_id: string;
  path: string;
  offset?: number;
  limit?: number;
}

export function executeAppFileRead(
  input: AppFileReadInput,
  store: AppStoreReader,
): ExecutorResult {
  const offset = input.offset ?? 1;
  const limit = input.limit;

  const raw = store.readAppFile(input.app_id, input.path);
  const allLines = raw.split('\n');
  const startIndex = Math.max(0, offset - 1);
  const sliced = limit != null ? allLines.slice(startIndex, startIndex + limit) : allLines.slice(startIndex);

  const formatted = sliced
    .map((line, i) => {
      const lineNum = startIndex + i + 1;
      return `${String(lineNum).padStart(6)}\t${line}`;
    })
    .join('\n');

  return { content: formatted, isError: false };
}

// ---------------------------------------------------------------------------
// app_file_edit
// ---------------------------------------------------------------------------

export interface AppFileEditInput {
  app_id: string;
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  status?: string;
}

export function executeAppFileEdit(
  input: AppFileEditInput,
  store: AppStore,
): ExecutorResult {
  if (!input.old_string) {
    return { content: JSON.stringify({ error: 'old_string must not be empty' }), isError: true };
  }

  const replaceAll = input.replace_all ?? false;
  const result = store.editAppFile(input.app_id, input.path, input.old_string, input.new_string, replaceAll);
  return { content: JSON.stringify(result), isError: false, status: input.status };
}

// ---------------------------------------------------------------------------
// app_file_write
// ---------------------------------------------------------------------------

export interface AppFileWriteInput {
  app_id: string;
  path: string;
  content: string;
  status?: string;
}

export function executeAppFileWrite(
  input: AppFileWriteInput,
  store: AppStore,
): ExecutorResult {
  const app = store.getApp(input.app_id);
  if (!app) {
    return { content: JSON.stringify({ error: `App '${input.app_id}' not found` }), isError: true };
  }

  store.writeAppFile(input.app_id, input.path, input.content);
  return { content: JSON.stringify({ written: true, path: input.path }), isError: false, status: input.status };
}

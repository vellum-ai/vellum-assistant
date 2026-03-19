/**
 * Standalone executor functions for app tool operations.
 *
 * Each executor encapsulates the business logic that was previously inline
 * in the tool definition's execute() handler.  They accept plain typed
 * parameters and return plain result objects, making them reusable from
 * both core tool handlers and skill scripts without depending on
 * ToolDefinition or ToolContext types.
 */

import { compileApp } from "../../bundler/app-compiler.js";
import { generateAppIcon } from "../../media/app-icon-generator.js";
import type {
  AppDefinition,
  EditEngineResult,
} from "../../memory/app-store.js";
import { getAppDirPath, isMultifileApp } from "../../memory/app-store.js";

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
// Dependency interfaces - callers inject these rather than importing the
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
    icon?: string;
    schemaJson: string;
    htmlDefinition: string;
    pages?: Record<string, string>;
    formatVersion?: number;
  }): AppDefinition;
  updateApp(
    id: string,
    updates: Partial<
      Pick<
        AppDefinition,
        "name" | "description" | "schemaJson" | "htmlDefinition" | "pages"
      >
    >,
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
// Path resolution - multifile apps default to src/ for file operations
// ---------------------------------------------------------------------------

/**
 * For multifile (formatVersion 2) apps, prepend `src/` to paths that don't
 * already target a known top-level directory (src/, dist/, records/).
 * Legacy apps pass through unchanged.
 */
export function resolveAppFilePath(app: AppDefinition, path: string): string {
  if (!isMultifileApp(app)) return path;
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    normalized.startsWith("src/") ||
    normalized.startsWith("dist/") ||
    normalized.startsWith("records/")
  ) {
    return normalized;
  }
  return `src/${normalized}`;
}

// ---------------------------------------------------------------------------
// app_create
// ---------------------------------------------------------------------------

export interface AppCreateInput {
  name: string;
  description?: string;
  schema_json?: string;
  html?: string;
  pages?: Record<string, string>;
  auto_open?: boolean;
  preview?: Record<string, unknown>;
  /** When provided, controls multifile scaffold behavior. */
  featureFlags?: { multifileEnabled: boolean };
}

export async function executeAppCreate(
  input: AppCreateInput,
  store: AppStore,
  proxyToolResolver?: ProxyResolver,
): Promise<ExecutorResult> {
  const name = input.name;
  const description = input.description;
  const schemaJson = input.schema_json ?? "{}";
  // Default to a minimal scaffold only when html is truly omitted; reject
  // invalid types (e.g. object/number) so malformed tool calls surface errors.
  let htmlDefinition: string;
  if (typeof input.html === "string") {
    htmlDefinition = input.html;
  } else if (input.html == null) {
    htmlDefinition = "<!DOCTYPE html><html><head></head><body></body></html>";
  } else {
    return {
      content: JSON.stringify({
        error: `html must be a string, got ${typeof input.html}`,
      }),
      isError: true,
    };
  }
  const pages = input.pages;
  const autoOpen = input.auto_open !== false; // default true
  const preview = input.preview;

  // Validate required fields - LLM input is not type-checked at runtime
  if (typeof name !== "string" || name.trim() === "") {
    return {
      content: JSON.stringify({
        error: "name is required and must be a non-empty string",
      }),
      isError: true,
    };
  }
  if (pages) {
    for (const [filename, content] of Object.entries(pages)) {
      if (typeof content !== "string") {
        return {
          content: JSON.stringify({
            error: `pages["${filename}"] must be a string, got ${typeof content}`,
          }),
          isError: true,
        };
      }
    }
  }

  // Extract icon from preview if provided - only persist emoji-like values,
  // not URLs which would render as raw strings in UI and bundle manifests.
  const rawIcon = preview?.icon as string | undefined;
  const icon = rawIcon && !rawIcon.startsWith("http") ? rawIcon : undefined;

  const multifileEnabled = input.featureFlags?.multifileEnabled === true;

  const app = store.createApp({
    name,
    description,
    icon,
    schemaJson,
    htmlDefinition: multifileEnabled ? "" : htmlDefinition,
    pages: multifileEnabled ? undefined : pages,
    formatVersion: multifileEnabled ? 2 : undefined,
  });

  // Scaffold multifile app with src/ files and compile to dist/
  if (multifileEnabled) {
    const htmlSafeName = name
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    const jsxSafeName = name.replace(/[<>{}&"']/g, "");

    const indexHtml =
      typeof input.html === "string"
        ? input.html
        : `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${htmlSafeName}</title>
</head>
<body>
  <div id="app"></div>
</body>
</html>`;

    const mainTsx = `import { render } from 'preact';

function App() {
  return <div>{"Hello, ${jsxSafeName}!"}</div>;
}

render(<App />, document.getElementById('app')!);
`;

    store.writeAppFile(app.id, "src/index.html", indexHtml);
    store.writeAppFile(app.id, "src/main.tsx", mainTsx);

    // Compile src/ → dist/
    const appDir = getAppDirPath(app.id);
    const compileResult = await compileApp(appDir);
    if (!compileResult.ok) {
      return {
        content: JSON.stringify({
          ...app,
          compile_errors: compileResult.errors,
          compile_warnings: compileResult.warnings,
          compile_duration_ms: compileResult.durationMs,
        }),
        isError: false,
      };
    }
  }

  // Emit the inline preview card via the proxy without opening a workspace panel.
  // open_mode: "preview" signals to the client that this should be shown inline only.
  if (autoOpen && proxyToolResolver) {
    const createPreview = {
      ...(preview ?? {}),
      context: "app_create" as const,
    };
    const extraInput = { preview: createPreview, open_mode: "preview" };
    try {
      const openResult = await proxyToolResolver("app_open", {
        app_id: app.id,
        ...extraInput,
      });
      if (openResult.isError) {
        return {
          content: JSON.stringify({
            ...app,
            auto_opened: false,
            auto_open_error: openResult.content,
          }),
          isError: false,
        };
      }
      return {
        content: JSON.stringify({
          ...app,
          auto_opened: true,
          open_result: openResult.content,
        }),
        isError: false,
      };
    } catch {
      // Preview emission failure is non-fatal - the app was created successfully.
      return {
        content: JSON.stringify({
          ...app,
          auto_opened: false,
          auto_open_error:
            "Failed to auto-open app. Use app_open to open it manually.",
        }),
        isError: false,
      };
    }
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
  const updates: Partial<
    Pick<
      AppDefinition,
      "name" | "description" | "schemaJson" | "htmlDefinition" | "pages"
    >
  > = {};
  if (typeof input.name === "string") updates.name = input.name;
  if (typeof input.description === "string")
    updates.description = input.description;
  if (typeof input.schema_json === "string")
    updates.schemaJson = input.schema_json;
  if (typeof input.html === "string") updates.htmlDefinition = input.html;
  if (input.pages && typeof input.pages === "object")
    updates.pages = input.pages;

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
  return {
    content: JSON.stringify({ deleted: true, appId: input.app_id }),
    isError: false,
  };
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
  const app = store.getApp(input.app_id);

  if (app && isMultifileApp(app)) {
    // Separate build output paths from source paths without mutating the
    // file path strings - consumers need clean paths for subsequent tool calls.
    const buildOutputPaths = files.filter((f) =>
      f.replace(/\\/g, "/").startsWith("dist/"),
    );
    return {
      content: JSON.stringify({
        files,
        buildOutput: buildOutputPaths,
      }),
      isError: false,
    };
  }

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

  const app = store.getApp(input.app_id);
  const resolvedPath = app ? resolveAppFilePath(app, input.path) : input.path;
  const raw = store.readAppFile(input.app_id, resolvedPath);
  const allLines = raw.split("\n");
  const startIndex = Math.max(0, offset - 1);
  const sliced =
    limit != null
      ? allLines.slice(startIndex, startIndex + limit)
      : allLines.slice(startIndex);

  const formatted = sliced
    .map((line, i) => {
      const lineNum = startIndex + i + 1;
      return `${String(lineNum).padStart(6)}\t${line}`;
    })
    .join("\n");

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
    return {
      content: JSON.stringify({ error: "old_string must not be empty" }),
      isError: true,
    };
  }

  const app = store.getApp(input.app_id);
  const resolvedPath = app ? resolveAppFilePath(app, input.path) : input.path;

  const replaceAll = input.replace_all ?? false;
  const result = store.editAppFile(
    input.app_id,
    resolvedPath,
    input.old_string,
    input.new_string,
    replaceAll,
  );
  return {
    content: JSON.stringify(result),
    isError: false,
    status: input.status,
  };
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
    return {
      content: JSON.stringify({ error: `App '${input.app_id}' not found` }),
      isError: true,
    };
  }

  const resolvedPath = resolveAppFilePath(app, input.path);
  store.writeAppFile(input.app_id, resolvedPath, input.content);
  return {
    content: JSON.stringify({ written: true, path: resolvedPath }),
    isError: false,
    status: input.status,
  };
}

// ---------------------------------------------------------------------------
// app_generate_icon
// ---------------------------------------------------------------------------

export interface AppGenerateIconInput {
  app_id: string;
  description?: string;
}

export async function executeAppGenerateIcon(
  input: AppGenerateIconInput,
  store: AppStoreReader,
): Promise<ExecutorResult> {
  const app = store.getApp(input.app_id);
  if (!app) {
    return {
      content: JSON.stringify({ error: `App '${input.app_id}' not found` }),
      isError: true,
    };
  }

  // Generate to a temp path first, then swap on success to avoid
  // destroying an existing icon if generation fails.
  const { existsSync, renameSync, unlinkSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { getAppDirPath: resolveAppDir } =
    await import("../../memory/app-store.js");
  const iconPath = join(resolveAppDir(input.app_id), "icon.png");
  const tempPath = join(resolveAppDir(input.app_id), "icon.tmp.png");

  // Temporarily move existing icon aside so generateAppIcon doesn't skip
  if (existsSync(iconPath)) {
    renameSync(iconPath, tempPath);
  }

  await generateAppIcon(
    input.app_id,
    app.name,
    input.description ?? app.description,
  );

  if (existsSync(iconPath)) {
    // Success - clean up the old icon backup
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
    return {
      content: JSON.stringify({ generated: true, appId: input.app_id }),
      isError: false,
    };
  }

  // Generation failed - restore the previous icon if we had one
  if (existsSync(tempPath)) {
    renameSync(tempPath, iconPath);
  }

  return {
    content: JSON.stringify({
      error:
        "Icon generation failed. Make sure a Gemini API key is configured in Settings.",
    }),
    isError: true,
  };
}

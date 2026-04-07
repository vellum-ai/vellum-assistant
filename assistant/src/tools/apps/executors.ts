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
import type { AppDefinition } from "../../memory/app-store.js";
import { getAppDirPath } from "../../memory/app-store.js";

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
  appFileExists(appId: string, path: string): boolean;
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

    // Only write scaffold files when they don't already exist on disk.
    // The LLM may have written custom source files via file_write before
    // calling app_create, and overwriting them would destroy the real app
    // content, leaving only the scaffold placeholder.
    if (!store.appFileExists(app.id, "src/index.html")) {
      store.writeAppFile(app.id, "src/index.html", indexHtml);
    }
    if (!store.appFileExists(app.id, "src/main.tsx")) {
      store.writeAppFile(app.id, "src/main.tsx", mainTsx);
    }

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
// app_refresh
// ---------------------------------------------------------------------------

export interface AppRefreshInput {
  app_id: string;
}

export async function executeAppRefresh(
  input: AppRefreshInput,
  store: AppStore,
): Promise<ExecutorResult> {
  const app = store.getApp(input.app_id);
  if (!app) {
    return {
      content: JSON.stringify({ error: `App '${input.app_id}' not found` }),
      isError: true,
    };
  }

  // Empty update bumps updatedAt timestamp, triggering surface refresh on
  // the client side.
  const updated = store.updateApp(input.app_id, {});

  // Multifile apps need an explicit compile so the LLM sees any errors
  // (bad imports, syntax issues, etc.) instead of silently serving the
  // stale scaffold placeholder from the initial app_create.
  if (app.formatVersion === 2) {
    const appDir = getAppDirPath(input.app_id);
    const compileResult = await compileApp(appDir);
    return {
      content: JSON.stringify({
        refreshed: true,
        appId: updated.id,
        name: updated.name,
        compiled: compileResult.ok,
        ...(compileResult.ok
          ? { compile_duration_ms: compileResult.durationMs }
          : {
              compile_errors: compileResult.errors,
              compile_warnings: compileResult.warnings,
              compile_duration_ms: compileResult.durationMs,
            }),
      }),
      isError: false,
    };
  }

  return {
    content: JSON.stringify({
      refreshed: true,
      appId: updated.id,
      name: updated.name,
    }),
    isError: false,
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
  const iconPath = join(getAppDirPath(input.app_id), "icon.png");
  const tempPath = join(getAppDirPath(input.app_id), "icon.tmp.png");

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

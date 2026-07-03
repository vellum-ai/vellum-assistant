/**
 * Standalone executor functions for app tool operations.
 *
 * Each executor encapsulates the business logic that was previously inline
 * in the tool definition's execute() handler.  They accept plain typed
 * parameters and return plain result objects, making them reusable from
 * both core tool handlers and skill scripts without depending on
 * ToolDefinition or ToolContext types.
 */

import type { AppDefinition } from "../../apps/app-store.js";
import { getAppDirPath } from "../../apps/app-store.js";
import { compileApp } from "../../bundler/app-compiler.js";
import { generateAppIcon } from "../../media/app-icon-generator.js";
import { getLogger } from "../../util/logger.js";

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
  /**
   * Associate a freshly created app with the conversation that created it.
   * Optional so test doubles need not implement it; the real store does.
   */
  addAppConversationId?(appId: string, conversationId: string): boolean;
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

/**
 * Validate a `source_files` map (LLM input is not type-checked at runtime).
 * Returns an error ExecutorResult when invalid, or null when absent/valid.
 */
function validateSourceFiles(sourceFiles: unknown): ExecutorResult | null {
  if (sourceFiles == null) {
    return null;
  }
  if (typeof sourceFiles !== "object" || Array.isArray(sourceFiles)) {
    return {
      content: JSON.stringify({
        error:
          "source_files must be an object mapping relative file paths to string contents",
      }),
      isError: true,
    };
  }
  for (const [key, val] of Object.entries(sourceFiles)) {
    if (typeof val !== "string") {
      return {
        content: JSON.stringify({
          error: `source_files["${key}"] must be a string, got ${typeof val}`,
        }),
        isError: true,
      };
    }
  }
  return null;
}

/**
 * Resolve an app name when the model omits it. The preview card's title is
 * "always include" guidance and almost always present, so it's the best
 * fallback — a real, meaningful name — before a generic placeholder.
 */
function resolveAppName(input: AppCreateInput): string {
  const previewTitle =
    input.preview && typeof input.preview.title === "string"
      ? input.preview.title
      : undefined;
  for (const candidate of [input.name, previewTitle]) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }
  return "New App";
}

/**
 * Compile-result fields shared by the app_refresh and app_update responses.
 * On failure the errors/warnings are surfaced so the agent can fix them.
 */
function compileResultPayload(
  compileResult: Awaited<ReturnType<typeof compileApp>>,
): Record<string, unknown> {
  return {
    compiled: compileResult.ok,
    ...(compileResult.ok
      ? { compile_duration_ms: compileResult.durationMs }
      : {
          compile_errors: compileResult.errors,
          compile_warnings: compileResult.warnings,
          compile_duration_ms: compileResult.durationMs,
        }),
  };
}

// ---------------------------------------------------------------------------
// app_create
// ---------------------------------------------------------------------------

export interface AppCreateInput {
  name: string;
  description?: string;
  schema_json?: string;
  /** Retired single-file shortcut. Returns a guidance error. */
  html?: unknown;
  /** Retired single-file multi-page shortcut. Returns a guidance error. */
  pages?: unknown;
  /** Lenient alias. Folded into preview.icon when preview.icon is absent. */
  icon?: unknown;
  auto_open?: boolean;
  preview?: Record<string, unknown>;
  source_files?: Record<string, string>;
}

export async function executeAppCreate(
  input: AppCreateInput,
  store: AppStore,
  proxyToolResolver?: ProxyResolver,
  conversationId?: string,
): Promise<ExecutorResult> {
  // The model sometimes omits a name; resolve a sensible one rather than
  // erroring out so the build still succeeds. Users can rename via app_update.
  const name = resolveAppName(input);
  const description = input.description;
  const schemaJson = input.schema_json ?? "{}";

  // Retired shortcut: a top-level `html` is no longer accepted. Reject with a
  // helpful message (rather than a cryptic schema error) so the model writes a
  // multi-file TSX app under src/ instead.
  if (Object.prototype.hasOwnProperty.call(input, "html")) {
    return {
      content: JSON.stringify({
        error:
          "app_create no longer accepts html. Build a multi-file TSX app under src/ (src/index.html + src/main.tsx + src/App.tsx) instead.",
      }),
      isError: true,
    };
  }

  if (Object.prototype.hasOwnProperty.call(input, "pages")) {
    return {
      content: JSON.stringify({
        error:
          "app_create no longer accepts pages. Build multi-file TSX apps under src/ and route inside the Preact app instead.",
      }),
      isError: true,
    };
  }
  const autoOpen = input.auto_open !== false; // default true
  const preview = input.preview;

  const sourceFilesError = validateSourceFiles(input.source_files);
  if (sourceFilesError) {
    return sourceFilesError;
  }

  // Extract icon from preview if provided - only persist emoji-like values,
  // not URLs which would render as raw strings in UI and bundle manifests.
  // Lenient alias: a top-level `icon` is folded in when preview.icon is absent.
  const rawIcon = (preview?.icon ??
    (typeof input.icon === "string" ? input.icon : undefined)) as
    | string
    | undefined;
  const icon = rawIcon && !rawIcon.startsWith("http") ? rawIcon : undefined;

  const app = store.createApp({
    name,
    description,
    icon,
    schemaJson,
    htmlDefinition: "",
    formatVersion: 2,
  });

  // Associate the app with its conversation at creation so subsequent
  // `app_*` calls in the same turn can resolve it even when the model omits
  // `app_id` (see resolveAppId). Without this the link is only formed at
  // `app_open`, leaving the create→update→refresh gap unresolvable.
  // Best-effort: a failed association must never fail the create.
  if (conversationId && store.addAppConversationId) {
    try {
      store.addAppConversationId(app.id, conversationId);
    } catch (err) {
      getLogger("app-executors").debug(
        { err, appId: app.id, conversationId },
        "Failed to associate app with conversation at create",
      );
    }
  }

  // Scaffold multifile app with src/ files and compile to dist/
  const htmlSafeName = name
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const jsxSafeName = name.replace(/[<>{}&"']/g, "");

  const indexHtml = `<!DOCTYPE html>
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

  if (input.source_files) {
    for (const [filePath, content] of Object.entries(input.source_files)) {
      store.writeAppFile(app.id, filePath, content);
    }
  }

  const mainTsxScaffolded = !store.appFileExists(app.id, "src/main.tsx");
  if (!store.appFileExists(app.id, "src/index.html")) {
    store.writeAppFile(app.id, "src/index.html", indexHtml);
  }
  if (mainTsxScaffolded) {
    store.writeAppFile(app.id, "src/main.tsx", mainTsx);
  }

  // When the placeholder main.tsx was actually scaffolded, the tool result
  // must steer the agent toward writing the real source files instead of
  // treating success + inline AppCard as task-done. When the agent pre-wrote
  // src/main.tsx before calling app_create, this directive would be false
  // and risks prompting a destructive rewrite, so omit it in that case.
  const nextStepsField = mainTsxScaffolded
    ? {
        next_steps:
          "Scaffold created with a placeholder src/main.tsx only. The app is NOT built yet. You MUST now (1) write the real src/main.tsx, components under src/components/, and src/styles.css with file_write, then (2) call app_refresh once. Stopping here leaves an empty Hello-world placeholder as the only result.",
      }
    : {};

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
        ...nextStepsField,
      }),
      isError: false,
    };
  }

  // Emit the inline preview card via the proxy without opening a workspace panel.
  // open_mode: "preview" signals to the client that this should be shown inline only.
  if (autoOpen && !mainTsxScaffolded && proxyToolResolver) {
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
            ...nextStepsField,
          }),
          isError: false,
        };
      }
      return {
        content: JSON.stringify({
          ...app,
          auto_opened: true,
          open_result: openResult.content,
          ...nextStepsField,
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
          ...nextStepsField,
        }),
        isError: false,
      };
    }
  }

  return {
    content: JSON.stringify({
      ...app,
      ...nextStepsField,
    }),
    isError: false,
  };
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
        ...compileResultPayload(compileResult),
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
// app_update
// ---------------------------------------------------------------------------

export interface AppUpdateInput {
  app_id: string;
  name?: string;
  description?: string;
  schema_json?: string;
  source_files?: Record<string, string>;
}

export async function executeAppUpdate(
  input: AppUpdateInput,
  store: AppStore,
): Promise<ExecutorResult> {
  const app = store.getApp(input.app_id);
  if (!app) {
    return {
      content: JSON.stringify({ error: `App '${input.app_id}' not found` }),
      isError: true,
    };
  }

  const sourceFilesError = validateSourceFiles(input.source_files);
  if (sourceFilesError) {
    return sourceFilesError;
  }

  if (input.source_files) {
    for (const [filePath, content] of Object.entries(input.source_files)) {
      store.writeAppFile(input.app_id, filePath, content);
    }
  }

  const updates: Partial<
    Pick<AppDefinition, "name" | "description" | "schemaJson">
  > = {};
  if (typeof input.name === "string" && input.name.trim() !== "") {
    updates.name = input.name.trim();
  }
  if (typeof input.description === "string") {
    updates.description = input.description;
  }
  if (typeof input.schema_json === "string") {
    updates.schemaJson = input.schema_json;
  }

  // An empty update still bumps updatedAt, triggering a client surface refresh.
  const updated = store.updateApp(input.app_id, updates);

  // Multifile apps recompile so the agent sees any errors from the edited
  // source instead of serving a stale dist (mirrors app_refresh).
  if (app.formatVersion === 2) {
    const appDir = getAppDirPath(input.app_id);
    const compileResult = await compileApp(appDir);
    return {
      content: JSON.stringify({
        updated: true,
        appId: updated.id,
        name: updated.name,
        description: updated.description,
        ...compileResultPayload(compileResult),
      }),
      isError: false,
    };
  }

  return {
    content: JSON.stringify({
      updated: true,
      appId: updated.id,
      name: updated.name,
      description: updated.description,
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
        "Icon generation failed. Make sure a Gemini API key is configured in Settings → Models & Services.",
    }),
    isError: true,
  };
}

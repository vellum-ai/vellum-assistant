/**
 * Compiler for multi-file TSX apps.
 *
 * Compiles src/main.tsx -> dist/main.js via esbuild's JS API using a warm,
 * incremental build context cached per app directory, then copies index.html
 * with script/style tag injection. Reusing the context lets esbuild keep its
 * module graph hot, so recompiles on source edits are typically sub-second.
 *
 * esbuild resolves its native binary relative to its package at module load,
 * which does not exist inside bun --compile's /$bunfs/. We point
 * ESBUILD_BINARY_PATH at the on-disk binary produced by ensureCompilerTools()
 * so the JS API works in both `bun run` and compiled-binary modes.
 */

import { existsSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import * as esbuild from "esbuild";

import { getLogger } from "../util/logger.js";
import { ensureCompilerTools } from "./compiler-tools.js";
import {
  getCacheDir,
  isBareImport,
  packageName,
  resolvePackage,
} from "./package-resolver.js";

const log = getLogger("app-compiler");

export interface CompileDiagnostic {
  text: string;
  location?: { file: string; line: number; column: number };
}

export interface CompileResult {
  ok: boolean;
  errors: CompileDiagnostic[];
  warnings: CompileDiagnostic[];
  durationMs: number;
}

/**
 * Map an esbuild JS API Message into our structured CompileDiagnostic shape:
 * the message text plus an optional { file, line, column } location.
 */
function toDiagnostic(message: esbuild.Message): CompileDiagnostic {
  const diag: CompileDiagnostic = { text: message.text };
  if (message.location) {
    diag.location = {
      file: message.location.file,
      line: message.location.line,
      column: message.location.column,
    };
  }
  return diag;
}

/**
 * Decode JS string escape sequences (\xHH, \uHHHH, \u{H+}, standard
 * escapes) so that obfuscated specifiers like `"\x2e\x2e/etc/passwd"` are
 * normalised before the path-containment check.
 */
function decodeJsEscapes(raw: string): string {
  return raw.replace(
    /\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|([nrtbfv0'"\\]))/g,
    (_, hex2, codePoint, hex4, std) => {
      if (hex2) return String.fromCharCode(parseInt(hex2, 16));
      if (codePoint) return String.fromCodePoint(parseInt(codePoint, 16));
      if (hex4) return String.fromCharCode(parseInt(hex4, 16));
      const map: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        v: "\v",
        "0": "\0",
        "'": "'",
        '"': '"',
        "\\": "\\",
      };
      return map[std] ?? std;
    },
  );
}

/**
 * Strip JS block comments and line comments from source, replacing them
 * with same-length whitespace so character offsets (used for line-number
 * calculation) are preserved.  String literals are left intact.
 */
function stripJsComments(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; ) {
    const c = source[i];
    const next = source[i + 1];

    // String literal — pass through unchanged
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += source[i++];
      while (i < source.length && source[i] !== q) {
        if (source[i] === "\\") {
          out += source[i++]; // backslash
        }
        if (i < source.length) out += source[i++]; // char or escaped char
      }
      if (i < source.length) out += source[i++]; // closing quote
      continue;
    }

    // Block comment → replace with spaces (keep newlines for line counting)
    if (c === "/" && next === "*") {
      out += "  "; // replace /*
      i += 2;
      while (
        i < source.length &&
        !(source[i] === "*" && source[i + 1] === "/")
      ) {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < source.length) {
        out += "  "; // replace */
        i += 2;
      }
      continue;
    }

    // Line comment → replace with spaces
    if (c === "/" && next === "/") {
      out += "  "; // replace //
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    out += source[i++];
  }
  return out;
}

/**
 * Validate that all relative/absolute import paths in source files resolve
 * within the app directory. This prevents crafted apps from importing
 * arbitrary host files (e.g. `import data from '../../../../etc/passwd'`).
 */
async function validateImportPaths(
  srcDir: string,
  appDir: string,
): Promise<CompileDiagnostic[]> {
  const resolvedAppDir = resolve(appDir);
  const errors: CompileDiagnostic[] = [];

  const files = await readdir(srcDir, { recursive: true });
  for (const file of files) {
    const fileName = String(file);
    const isJs = /\.[jt]sx?$/.test(fileName);
    const isCss = /\.css$/.test(fileName);
    if (!isJs && !isCss) continue;

    const filePath = join(srcDir, fileName);
    const content = await readFile(filePath, "utf-8");
    const fileDir = dirname(filePath);

    // Strip JS comments so patterns like `from /* */ "path"` are detected
    const scannable = isJs ? stripJsComments(content) : content;

    const specifiers: Array<{ specifier: string; index: number }> = [];

    if (isJs) {
      // Match: from "x", import "x", import("x"), require("x")
      const re = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;
      for (const m of scannable.matchAll(re)) {
        specifiers.push({ specifier: m[1], index: m.index! });
      }
    } else {
      // CSS: @import "x", @import url("x"), url("x")
      const re =
        /(?:@import\s+(?:url\s*\(\s*)?|url\s*\(\s*)["']?([^"')\s;]+)["']?/g;
      for (const m of content.matchAll(re)) {
        if (m[1]) specifiers.push({ specifier: m[1], index: m.index! });
      }
    }

    for (const { specifier, index } of specifiers) {
      // Decode JS string escapes so \x2e\x2e/… is normalised to ../../…
      const decoded = isJs ? decodeJsEscapes(specifier) : specifier;

      // Only validate path-based imports (starting with . or /)
      if (!decoded.startsWith(".") && !decoded.startsWith("/")) continue;

      const resolved = resolve(fileDir, decoded);
      if (
        !resolved.startsWith(resolvedAppDir + "/") &&
        resolved !== resolvedAppDir
      ) {
        const line = content.substring(0, index).split("\n").length;
        errors.push({
          text: `Import "${specifier}" resolves outside the app directory`,
          location: { file: fileName, line, column: 0 },
        });
      }
    }
  }

  return errors;
}

/**
 * Scan source files for bare import specifiers and pre-install any
 * allowlisted packages into the shared cache so esbuild can resolve them.
 */
async function resolveAppImports(srcDir: string): Promise<void> {
  const importRe = /(?:import|from)\s+["']([^"'.][^"']*)["']/g;
  const seen = new Set<string>();
  const failed: string[] = [];

  const files = await readdir(srcDir, { recursive: true });
  for (const file of files) {
    if (!/\.[jt]sx?$/.test(String(file))) continue;
    const content = await readFile(join(srcDir, String(file)), "utf-8");
    for (const match of content.matchAll(importRe)) {
      const specifier = match[1];
      if (!isBareImport(specifier)) continue;
      const pkg = packageName(specifier);
      if (seen.has(pkg)) continue;
      seen.add(pkg);
      const result = await resolvePackage(pkg);
      if (result === null) {
        failed.push(pkg);
      }
    }
  }

  if (failed.length > 0) {
    log.warn(
      { failed },
      "Some imported packages could not be resolved — esbuild may fail",
    );
  }
}

/**
 * Per-appDir compile serialisation.
 *
 * compileApp() begins by `rm -rf dist/`, so two concurrent compiles on the
 * same appDir can wipe each other's intermediate output. To prevent that
 * while still picking up source edits that arrive mid-build, we track a
 * two-slot queue per appDir:
 *
 * - `current`: the compile that is currently writing to dist/.
 * - `pending`: at most one coalesced follow-up compile queued because a new
 *   caller arrived while `current` was running. Additional callers arriving
 *   during that window share `pending` — they do not spawn yet another run.
 *   Once `current` settles, `pending` is promoted to `current` and begins
 *   executing; new callers arriving after promotion queue a fresh `pending`.
 *
 * This keeps dist/ consistent under concurrency while guaranteeing that any
 * source mutation observed after a compile starts will be reflected in a
 * subsequent compile pass rather than silently dropped.
 */
interface CompileSlot {
  current: Promise<CompileResult>;
  pending?: Promise<CompileResult>;
}

const compileSlots = new Map<string, CompileSlot>();

/**
 * Warm esbuild build contexts, one per app directory.
 *
 * The first compile for an appDir creates a context and caches it; subsequent
 * compiles call ctx.rebuild(), which reuses esbuild's hot module graph and is
 * typically sub-second. A stable `key` fingerprinting the resolution-relevant
 * build options (entry points + nodePaths) is recorded so the context can be
 * torn down and rebuilt if any of them change — e.g. a new top-level source
 * file is added, or the user adds an allowed third-party import whose newly
 * installed package cache extends nodePaths.
 */
interface CachedContext {
  ctx: esbuild.BuildContext;
  key: string;
}

const appContexts = new Map<string, CachedContext>();

/**
 * Test/diagnostics hook: counts how many times a fresh esbuild context was
 * created (vs reused). A reused context increments rebuildCount instead.
 */
const contextStats = { createCount: 0, rebuildCount: 0 };

/** Exposed for tests: read and reset the context create/rebuild counters. */
export function __getAppCompilerContextStats(): {
  createCount: number;
  rebuildCount: number;
} {
  return { ...contextStats };
}

/** Exposed for tests: reset the context create/rebuild counters. */
export function __resetAppCompilerContextStats(): void {
  contextStats.createCount = 0;
  contextStats.rebuildCount = 0;
}

/**
 * Build a stable identity key for the resolution-relevant build options.
 *
 * Two contexts are interchangeable only if they share the same entry points
 * AND the same module-resolution roots (nodePaths). Sorting makes the key
 * order-insensitive so a reorder alone never forces a needless recreate, while
 * any added/removed entry point or nodePath does.
 */
function contextKey(entryPoints: string[], nodePaths: string[]): string {
  return JSON.stringify({
    entryPoints: [...entryPoints].sort(),
    nodePaths: [...nodePaths].sort(),
  });
}

/**
 * Whether ESBUILD_BINARY_PATH has been pointed at the on-disk binary.
 * esbuild resolves its binary lazily on the first build, so this must be set
 * before any context is created — but only once, since esbuild caches it.
 */
let esbuildBinaryConfigured = false;

/**
 * Get (or lazily create) the warm esbuild context for an appDir, recreating it
 * if any resolution-relevant build option (entry points or nodePaths) changed
 * since it was cached.
 */
async function getOrCreateContext(
  appDir: string,
  entryPoints: string[],
  distDir: string,
  nodePaths: string[],
): Promise<esbuild.BuildContext> {
  const key = contextKey(entryPoints, nodePaths);
  const cached = appContexts.get(appDir);
  if (cached) {
    if (cached.key === key) {
      contextStats.rebuildCount++;
      return cached.ctx;
    }
    // A resolution input changed (entry points or nodePaths) — dispose the
    // stale context and build a fresh one so esbuild picks up the new paths.
    appContexts.delete(appDir);
    await cached.ctx.dispose();
  }

  const ctx = await esbuild.context({
    entryPoints,
    bundle: true,
    minify: true,
    outdir: distDir,
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    alias: { react: "preact/compat", "react-dom": "preact/compat" },
    loader: {
      ".tsx": "tsx",
      ".ts": "ts",
      ".jsx": "jsx",
      ".js": "js",
      ".css": "css",
    },
    nodePaths,
    logLevel: "silent",
    absWorkingDir: appDir,
  });
  contextStats.createCount++;
  appContexts.set(appDir, { ctx, key });
  return ctx;
}

/**
 * Dispose every cached esbuild context and stop their child esbuild services.
 * Called on daemon shutdown so no esbuild subprocesses are left running.
 */
export async function disposeAppCompilerContexts(): Promise<void> {
  const contexts = [...appContexts.values()];
  appContexts.clear();
  await Promise.all(
    contexts.map(({ ctx }) =>
      ctx.dispose().catch((err) => {
        log.warn({ err }, "Failed to dispose esbuild context");
      }),
    ),
  );
}

/**
 * Compile a TSX app from appDir/src/ into appDir/dist/.
 *
 * Expects appDir/src/main.tsx as the entry point and appDir/src/index.html
 * as the HTML shell. Produces appDir/dist/main.js and appDir/dist/index.html
 * (with script and optional stylesheet tags injected).
 *
 * Concurrent calls for the same appDir are serialised (see `compileSlots`
 * above). Callers never see a partial or racing dist/ write; callers that
 * represent work requested after a compile started always get a subsequent
 * fresh compile.
 */
export function compileApp(appDir: string): Promise<CompileResult> {
  const slot = compileSlots.get(appDir);

  if (!slot) {
    const current = runCompile(appDir);
    const onSettled = () => slotCompileSettled(appDir, current);
    current.then(onSettled, onSettled);
    compileSlots.set(appDir, { current });
    return current;
  }

  if (slot.pending) return slot.pending;

  // A second distinct caller arrived while `current` is running. Queue a
  // follow-up that starts once `current` settles (success or failure) so
  // any source edits that happened mid-build still get compiled.
  const rerun = async (): Promise<CompileResult> => {
    try {
      await slot.current;
    } catch {
      // Ignore: we want to rerun regardless of the prior compile's outcome.
    }
    return runCompile(appDir);
  };
  const pending = rerun();
  const onSettled = () => slotCompileSettled(appDir, pending);
  pending.then(onSettled, onSettled);
  slot.pending = pending;
  return pending;
}

function slotCompileSettled(
  appDir: string,
  finished: Promise<CompileResult>,
): void {
  const slot = compileSlots.get(appDir);
  if (!slot) return;

  if (slot.current !== finished) {
    // finished is a rerun that hasn't been promoted yet, or a stale entry.
    // Promotion happens below when `current` settles; there is nothing to do
    // here because a subsequent slotCompileSettled(current) will run first.
    return;
  }

  if (slot.pending) {
    compileSlots.set(appDir, { current: slot.pending });
  } else {
    compileSlots.delete(appDir);
  }
}

async function runCompile(appDir: string): Promise<CompileResult> {
  const start = performance.now();
  const srcDir = join(appDir, "src");
  const distDir = join(appDir, "dist");
  const entryPoint = join(srcDir, "main.tsx");

  // Clear stale dist/ output so removed assets (e.g. CSS) don't persist
  if (existsSync(distDir)) {
    rmSync(distDir, { recursive: true, force: true });
  }
  await mkdir(distDir, { recursive: true });

  // JIT download esbuild binary + preact on first use
  let tools;
  try {
    tools = await ensureCompilerTools();
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const text = err instanceof Error ? err.message : String(err);
    log.error({ err, durationMs }, "Failed to ensure compiler tools");
    return {
      ok: false,
      errors: [{ text: `Compiler setup failed: ${text}` }],
      warnings: [],
      durationMs,
    };
  }

  // Validate that path-based imports don't escape the app directory
  const pathErrors = await validateImportPaths(srcDir, appDir);
  if (pathErrors.length > 0) {
    const durationMs = Math.round(performance.now() - start);
    log.info(
      { durationMs, errorCount: pathErrors.length },
      "Build blocked: imports resolve outside app directory",
    );
    return { ok: false, errors: pathErrors, warnings: [], durationMs };
  }

  // Scan source files for bare imports and JIT-install allowed packages
  await resolveAppImports(srcDir);

  // Point esbuild's JS API at the on-disk binary. esbuild otherwise resolves
  // it relative to its package, which doesn't exist inside bun --compile's
  // /$bunfs/. esbuild caches the path on first build, so set it only once.
  if (!esbuildBinaryConfigured) {
    process.env.ESBUILD_BINARY_PATH = tools.esbuildBin;
    esbuildBinaryConfigured = true;
  }

  // Resolution roots for bare imports: preact parent dir + shared package cache
  const preactParent = dirname(tools.preactDir);
  const cacheNodeModules = join(getCacheDir(), "node_modules");
  const nodePaths = [preactParent, cacheNodeModules].filter((p) =>
    existsSync(p),
  );

  // esbuild's rebuild() resolves with an empty errors array on success and
  // rejects with a BuildFailure carrying errors/warnings on failure.
  let result: esbuild.BuildResult;
  try {
    const ctx = await getOrCreateContext(
      appDir,
      [entryPoint],
      distDir,
      nodePaths,
    );
    result = await ctx.rebuild();
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const failure = err as Partial<esbuild.BuildFailure>;
    const errors = (failure.errors ?? []).map(toDiagnostic);
    const warnings = (failure.warnings ?? []).map(toDiagnostic);
    if (errors.length === 0) {
      errors.push({ text: err instanceof Error ? err.message : String(err) });
    }
    log.info({ durationMs, errorCount: errors.length }, "Build failed");
    return { ok: false, errors, warnings, durationMs };
  }

  const warnings = result.warnings.map(toDiagnostic);

  // Copy index.html and inject script/style tags
  const htmlSrc = join(srcDir, "index.html");
  if (existsSync(htmlSrc)) {
    let html = await readFile(htmlSrc, "utf-8");

    // Check if CSS output was produced
    const distFiles = await readdir(distDir);
    const hasCss = distFiles.some((f) => f.endsWith(".css"));

    // Inject stylesheet link into <head> if CSS exists and not already present
    if (hasCss && !html.includes('href="main.css"')) {
      html = html.replace(
        "</head>",
        '  <link rel="stylesheet" href="main.css">\n  </head>',
      );
    }

    // Inject script tag before </body> if not already present
    if (!html.includes('src="main.js"')) {
      html = html.replace(
        "</body>",
        '  <script type="module" src="main.js"></script>\n  </body>',
      );
    }

    await writeFile(join(distDir, "index.html"), html);
  }

  const durationMs = Math.round(performance.now() - start);
  log.info({ durationMs }, "Build succeeded");
  return { ok: true, errors: [], warnings, durationMs };
}

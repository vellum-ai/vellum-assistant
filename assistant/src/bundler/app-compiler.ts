/**
 * Compiler for multi-file TSX apps.
 *
 * Shells out to the esbuild CLI binary (JIT-downloaded on first use) to
 * compile src/main.tsx -> dist/main.js, then copies index.html with
 * script/style tag injection.
 *
 * This avoids importing esbuild's JS API (which caches its native binary
 * path at module load time and breaks inside bun --compile's /$bunfs/).
 */

import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
  builtAt: number;
}

const COMPILE_STATUS_FILENAME = ".vellum-compile-status.json";

function getCompileStatusPath(appDir: string): string {
  return join(appDir, "dist", COMPILE_STATUS_FILENAME);
}

async function writeCompileStatus(
  appDir: string,
  result: CompileResult,
): Promise<void> {
  await mkdir(join(appDir, "dist"), { recursive: true });
  await writeFile(
    getCompileStatusPath(appDir),
    JSON.stringify(result, null, 2),
    "utf-8",
  );
}

export function readCompileStatus(appDir: string): CompileResult | null {
  const statusPath = getCompileStatusPath(appDir);
  if (!existsSync(statusPath)) return null;

  try {
    return JSON.parse(readFileSync(statusPath, "utf-8")) as CompileResult;
  } catch (err) {
    log.warn({ appDir, err }, "Failed to read compile status artifact");
    return null;
  }
}

export function formatCompileStatusMessage(
  result: Pick<CompileResult, "ok" | "errors">,
): string | undefined {
  if (result.ok) return undefined;

  if (result.errors.length === 0) {
    return "Build failed";
  }

  const firstError = result.errors[0];
  const location = firstError.location
    ? ` (${basename(firstError.location.file)}:${firstError.location.line}:${firstError.location.column})`
    : "";
  const remainingCount = result.errors.length - 1;
  const suffix = remainingCount > 0 ? ` (+${remainingCount} more)` : "";

  return `Build failed: ${firstError.text}${location}${suffix}`;
}

/**
 * Parse esbuild CLI stderr into structured diagnostics.
 * esbuild outputs errors like:
 *   ✘ [ERROR] Could not resolve "foo"
 *       src/main.tsx:3:7:
 */
function parseEsbuildStderr(stderr: string): {
  errors: CompileDiagnostic[];
  warnings: CompileDiagnostic[];
} {
  const errors: CompileDiagnostic[] = [];
  const warnings: CompileDiagnostic[] = [];
  const lines = stderr.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const errorMatch = lines[i].match(/✘ \[ERROR\] (.+)/);
    const warnMatch = lines[i].match(/▲ \[WARNING\] (.+)/);

    if (errorMatch || warnMatch) {
      const text = (errorMatch ?? warnMatch)![1];
      const diag: CompileDiagnostic = { text };

      // Next non-empty line may have location: "    file:line:col:"
      const locLine = lines[i + 1]?.trim();
      if (locLine) {
        const locMatch = locLine.match(/^(.+):(\d+):(\d+):?$/);
        if (locMatch) {
          diag.location = {
            file: locMatch[1],
            line: parseInt(locMatch[2], 10),
            column: parseInt(locMatch[3], 10),
          };
        }
      }

      if (errorMatch) errors.push(diag);
      else warnings.push(diag);
    }
  }

  return { errors, warnings };
}

/**
 * Scan source files for bare import specifiers and pre-install any
 * allowlisted packages into the shared cache so esbuild can resolve them.
 */
async function resolveAppImports(srcDir: string): Promise<void> {
  const importRe = /(?:import|from)\s+["']([^"'.][^"']*)["']/g;
  const seen = new Set<string>();

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
      await resolvePackage(pkg);
    }
  }
}

/**
 * Compile a TSX app from appDir/src/ into appDir/dist/.
 *
 * Expects appDir/src/main.tsx as the entry point and appDir/src/index.html
 * as the HTML shell. Produces appDir/dist/main.js and appDir/dist/index.html
 * (with script and optional stylesheet tags injected).
 */
export async function compileApp(appDir: string): Promise<CompileResult> {
  const start = performance.now();
  const srcDir = join(appDir, "src");
  const distDir = join(appDir, "dist");
  const entryPoint = join(srcDir, "main.tsx");
  const tempDistDir = await mkdtemp(join(appDir, ".dist-tmp-"));

  const finish = async (
    payload: Omit<CompileResult, "builtAt">,
  ): Promise<CompileResult> => {
    const result: CompileResult = {
      ...payload,
      builtAt: Date.now(),
    };
    await writeCompileStatus(appDir, result);
    return result;
  };

  const finishUnexpectedError = async (
    err: unknown,
  ): Promise<CompileResult> => {
    const durationMs = Math.round(performance.now() - start);
    const text = err instanceof Error ? err.message : String(err);
    log.error({ err, durationMs }, "Build threw unexpectedly");
    return finish({
      ok: false,
      errors: [{ text }],
      warnings: [],
      durationMs,
    });
  };

  try {
    // JIT download esbuild binary + preact on first use
    let tools;
    try {
      tools = await ensureCompilerTools();
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      const text = err instanceof Error ? err.message : String(err);
      log.error({ err, durationMs }, "Failed to ensure compiler tools");
      return finish({
        ok: false,
        errors: [{ text: `Compiler setup failed: ${text}` }],
        warnings: [],
        durationMs,
      });
    }

    // Scan source files for bare imports and JIT-install allowed packages
    await resolveAppImports(srcDir);

    // Build NODE_PATH: preact parent dir + shared package cache
    const preactParent = dirname(tools.preactDir);
    const cacheNodeModules = join(getCacheDir(), "node_modules");
    const nodePath = [preactParent, cacheNodeModules]
      .filter((p) => existsSync(p))
      .join(":");

    // Shell out to esbuild CLI
    const args = [
      entryPoint,
      "--bundle",
      "--minify",
      `--outdir=${tempDistDir}`,
      "--format=esm",
      "--target=es2022",
      "--jsx=automatic",
      "--jsx-import-source=preact",
      "--alias:react=preact/compat",
      "--alias:react-dom=preact/compat",
      "--loader:.tsx=tsx",
      "--loader:.ts=ts",
      "--loader:.jsx=jsx",
      "--loader:.js=js",
      "--loader:.css=css",
      "--log-level=warning",
    ];

    const proc = Bun.spawn({
      cmd: [tools.esbuildBin, ...args],
      cwd: appDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NODE_PATH: nodePath },
    });

    await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    if (proc.exitCode !== 0) {
      const durationMs = Math.round(performance.now() - start);
      const { errors, warnings } = parseEsbuildStderr(stderr);
      // If parsing found nothing, use raw stderr as the error
      if (errors.length === 0 && stderr.trim()) {
        errors.push({ text: stderr.trim() });
      }
      log.info({ durationMs, errorCount: errors.length }, "Build failed");
      return finish({ ok: false, errors, warnings, durationMs });
    }

    // Copy index.html and inject script/style tags
    const htmlSrc = join(srcDir, "index.html");
    if (existsSync(htmlSrc)) {
      let html = await readFile(htmlSrc, "utf-8");

      // Check if CSS output was produced
      const distFiles = await readdir(tempDistDir);
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

      await writeFile(join(tempDistDir, "index.html"), html);
    }

    await rm(distDir, { recursive: true, force: true });
    await rename(tempDistDir, distDir);

    const durationMs = Math.round(performance.now() - start);
    log.info({ durationMs }, "Build succeeded");
    return finish({ ok: true, errors: [], warnings: [], durationMs });
  } catch (err) {
    return finishUnexpectedError(err);
  } finally {
    await rm(tempDistDir, { recursive: true, force: true });
  }
}

/**
 * esbuild wrapper for compiling multi-file TSX apps.
 *
 * Compiles src/main.tsx → dist/main.js, copies index.html with
 * script/style tag injection, and returns structured diagnostics.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { build, type Message, type Plugin } from "esbuild";

import { getLogger } from "../util/logger.js";
import {
  ALLOWED_PACKAGES,
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

function mapDiagnostics(messages: Message[]): CompileDiagnostic[] {
  return messages.map((msg) => ({
    text: msg.text,
    ...(msg.location
      ? {
          location: {
            file: msg.location.file,
            line: msg.location.line,
            column: msg.location.column,
          },
        }
      : {}),
  }));
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

  await mkdir(distDir, { recursive: true });

  // Resolve preact from the assistant's own node_modules so per-app
  // directories don't need their own copy.
  const preactDir = resolve(
    import.meta.dirname ?? __dirname,
    "../../node_modules/preact",
  );

  // Plugin that resolves bare third-party imports against the allowlist
  const resolvePlugin: Plugin = {
    name: "vellum-package-resolver",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /.*/ }, async (args) => {
        // Only intercept bare specifiers (not relative, not preact/react aliases)
        if (
          args.kind !== "import-statement" &&
          args.kind !== "dynamic-import"
        ) {
          return undefined;
        }
        if (!isBareImport(args.path)) return undefined;

        const pkg = packageName(args.path);
        const nodeModulesDir = await resolvePackage(pkg);

        if (nodeModulesDir) {
          // Let esbuild resolve normally — nodePaths will pick it up
          return undefined;
        }

        // Not allowed — produce a clear error
        return {
          errors: [
            {
              text: `Package '${pkg}' is not in the allowed list. Allowed: ${ALLOWED_PACKAGES.join(", ")}`,
            },
          ],
        };
      });
    },
  };

  const cacheNodeModules = join(getCacheDir(), "node_modules");

  let result;
  try {
    result = await build({
      entryPoints: [entryPoint],
      bundle: true,
      minify: true,
      sourcemap: false,
      outdir: distDir,
      format: "esm",
      target: ["es2022"],
      jsx: "automatic",
      jsxImportSource: "preact",
      loader: {
        ".tsx": "tsx",
        ".ts": "ts",
        ".jsx": "jsx",
        ".js": "js",
        ".css": "css",
      },
      alias: {
        react: "preact/compat",
        "react-dom": "preact/compat",
      },
      plugins: [resolvePlugin],
      // Point esbuild at assistant's preact and at the shared package cache
      nodePaths: [resolve(preactDir, ".."), cacheNodeModules],
      logLevel: "silent",
    });
  } catch (err: unknown) {
    // esbuild throws on hard failures (e.g. syntax errors) with .errors/.warnings
    const esbuildErr = err as {
      errors?: Message[];
      warnings?: Message[];
    };
    const durationMs = Math.round(performance.now() - start);
    const errors = mapDiagnostics(esbuildErr.errors ?? []);
    const warnings = mapDiagnostics(esbuildErr.warnings ?? []);
    log.info({ durationMs, errorCount: errors.length }, "Build failed");
    return { ok: false, errors, warnings, durationMs };
  }

  const errors = mapDiagnostics(result.errors);
  const warnings = mapDiagnostics(result.warnings);

  if (errors.length > 0) {
    const durationMs = Math.round(performance.now() - start);
    log.info({ durationMs, errorCount: errors.length }, "Build failed");
    return { ok: false, errors, warnings, durationMs };
  }

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
  return { ok: true, errors, warnings, durationMs };
}

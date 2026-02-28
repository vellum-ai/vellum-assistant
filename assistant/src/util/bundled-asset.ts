import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Resolve the path to a bundled asset directory, handling compiled Bun binaries
 * where `import.meta.dirname` points to the `/$bunfs/` virtual filesystem and
 * non-JS files (.md, .html, .json, etc.) are not embedded.
 *
 * Falls back to:
 *   1. `Contents/Resources/<bundleName>` (macOS .app bundle)
 *   2. `<execDir>/<bundleName>` (next to the binary, non-app-bundle deployments)
 *   3. Original resolved path (source mode, or last resort)
 *
 * This matches the pattern established by bundled-skills and WASM resolution.
 *
 * @param callerDir  `import.meta.dirname ?? __dirname` from the call site
 * @param relativePath  Relative path from the source file (used in source/dev mode)
 * @param bundleName  Name of the asset directory in the app bundle
 */
export function resolveBundledDir(callerDir: string, relativePath: string, bundleName: string): string {
  if (callerDir.startsWith('/$bunfs/')) {
    const execDir = dirname(process.execPath);
    // macOS .app bundle: binary in Contents/MacOS/, resources in Contents/Resources/
    const resourcesPath = join(execDir, '..', 'Resources', bundleName);
    if (existsSync(resourcesPath)) return resourcesPath;
    // Next to the binary itself (non-app-bundle deployments)
    const execDirPath = join(execDir, bundleName);
    if (existsSync(execDirPath)) return execDirPath;
  }
  return join(callerDir, relativePath);
}
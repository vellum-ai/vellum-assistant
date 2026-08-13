import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const loadModule = createRequire(import.meta.url);

interface WebDistOptions {
  execPath?: string;
  platform?: NodeJS.Platform;
  resolvePackage?: () => string;
  startDir?: string;
}

/** Locate the pre-built web SPA for installed, packaged, or source CLIs. */
export function findWebDistDir(options: WebDistOptions = {}): string | null {
  try {
    const packageJson = (
      options.resolvePackage ??
      (() => loadModule.resolve("@vellumai/web/package.json"))
    )();
    const distDir = join(dirname(packageJson), "dist");
    if (existsSync(join(distDir, "index.html"))) {
      return distDir;
    }
  } catch {}

  if ((options.platform ?? process.platform) === "win32") {
    const runtimeDir = dirname(options.execPath ?? process.execPath);
    const packagedDist = join(runtimeDir, "web-dist");
    if (existsSync(join(packagedDist, "index.html"))) {
      return packagedDist;
    }
  }

  let dir = options.startDir ?? import.meta.dir;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, "clients", "web", "dist", "index.html");
    if (existsSync(candidate)) {
      return dirname(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export function findPackageDir(specifier: string, basedir: string): string {
  let current = path.dirname(Bun.resolveSync(specifier, basedir));
  for (;;) {
    if (existsSync(path.join(current, "package.json"))) {
      return realpathSync(current);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not locate package directory for ${specifier}.`);
    }
    current = parent;
  }
}

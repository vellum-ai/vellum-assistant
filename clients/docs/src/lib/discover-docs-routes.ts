import fs from "fs";
import path from "path";

const DOCS_APP_DIR = path.join(process.cwd(), "src", "app", "docs");

/**
 * Routes whose page only issues a permanentRedirect. Redirect targets belong
 * in the sitemap; the stubs themselves do not.
 */
export const REDIRECT_STUB_ROUTES: ReadonlySet<string> = new Set([
  "/docs/getting-started/key-concepts",
]);

/**
 * Recursively finds all page.tsx files under src/app/docs and converts them
 * to /docs/... URL paths. Strips route groups like (documentation) and
 * (releases), skips dynamic segments, private folders (underscore-prefixed,
 * e.g. _components and _md), and the api subtree directly under /docs
 * (route handlers, not pages).
 */
export function discoverDocsRoutes(dir: string = DOCS_APP_DIR): string[] {
  return walk(dir, "/docs").sort();
}

function walk(dir: string, basePath: string): string[] {
  const routes: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return routes;
  }

  const hasPage = entries.some(
    (e) => e.isFile() && (e.name === "page.tsx" || e.name === "page.ts"),
  );
  if (hasPage) {
    routes.push(basePath);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const name = entry.name;

    if (name.startsWith("[") || name.startsWith("_")) {
      continue;
    }
    if (basePath === "/docs" && name === "api") {
      continue;
    }

    const isRouteGroup = name.startsWith("(") && name.endsWith(")");
    const segment = isRouteGroup ? "" : `/${name}`;

    routes.push(...walk(path.join(dir, name), `${basePath}${segment}`));
  }

  return routes;
}

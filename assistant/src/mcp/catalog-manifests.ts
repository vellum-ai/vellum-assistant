import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  parseStandardDefinitions,
  type StandardDefinitionIssue,
  type StandardDefinitionsResult,
} from "./standard-definitions.js";

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function readDocument(
  root: string,
  name: "plugin.json" | "mcp.json",
): Promise<unknown> {
  const path = await realpath(join(root, name));
  if (!within(root, path)) {
    throw Object.assign(
      new Error(`${name} resolves outside the package root`),
      { catalogCode: "path_escape" },
    );
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      throw new Error(`${name} must be a regular file no larger than 1 MiB`);
    }
    try {
      return JSON.parse(await file.readFile("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw Object.assign(new Error(`${name} is not valid JSON`), {
          catalogCode: "invalid_json",
        });
      }
      throw error;
    }
  } finally {
    await file.close();
  }
}

/** Reads fixed standard documents as data inside a verified package boundary. */
export async function readStandardCatalogPackage(
  packageRoot: string,
  boundaryRoot: string = packageRoot,
): Promise<StandardDefinitionsResult> {
  try {
    const [root, boundary] = await Promise.all([
      realpath(packageRoot),
      realpath(boundaryRoot),
    ]);
    if (!within(boundary, root)) {
      return {
        ok: false,
        issues: [
          {
            code: "path_escape",
            message: "Package root escapes the reviewed source directory",
          },
        ],
      };
    }
    const plugin = await readDocument(root, "plugin.json");
    const manifest = parseStandardDefinitions(plugin);
    if (!manifest.ok) {
      return manifest;
    }
    let mcp: unknown;
    try {
      mcp = await readDocument(root, "mcp.json");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return parseStandardDefinitions(plugin, mcp);
  } catch (error) {
    const typed = error as Error & {
      catalogCode?: StandardDefinitionIssue["code"];
    };
    return {
      ok: false,
      issues: [
        { code: typed.catalogCode ?? "read_error", message: typed.message },
      ],
    };
  }
}

import { join } from "node:path";

import { resolveBundledDir } from "../util/bundled-asset.js";

/** Returns the path to the bundled UPDATES.md template. Extracted for testability. */
export function getTemplatePath(): string {
  const dir = resolveBundledDir(
    import.meta.dirname ?? __dirname,
    "templates",
    "templates",
  );
  return join(dir, "UPDATES.md");
}

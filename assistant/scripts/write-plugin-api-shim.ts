import path from "node:path";

import { ensurePluginApiShim } from "../src/plugins/ensure-plugin-api-shim.js";

const outputDir = Bun.argv[2];
if (!outputDir || !path.isAbsolute(outputDir)) {
  throw new Error("An absolute plugin API shim output directory is required.");
}

await ensurePluginApiShim({ workspaceDir: outputDir });

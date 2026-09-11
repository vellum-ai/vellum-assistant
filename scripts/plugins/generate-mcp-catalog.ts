#!/usr/bin/env bun
import { fileURLToPath } from "node:url";

import { generateMcpCatalog } from "../../assistant/src/mcp/catalog-generator.js";
import { ConfigError } from "../../assistant/src/util/errors.js";

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) {
    throw new ConfigError(
      "Usage: bun scripts/plugins/generate-mcp-catalog.ts [--check]",
    );
  }
  await generateMcpCatalog(
    fileURLToPath(new URL("../../", import.meta.url)),
    args.includes("--check"),
  );
}

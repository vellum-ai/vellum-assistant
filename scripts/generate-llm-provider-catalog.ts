#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { PROVIDER_CATALOG } from "../assistant/src/providers/model-catalog.js";

const CATALOG_VERSION = 1;
const repoRoot =
  basename(process.cwd()) === "scripts" ? dirname(process.cwd()) : process.cwd();
const catalogPath = join(repoRoot, "meta", "llm-provider-catalog.json");

export function serializeLlmProviderCatalog(): string {
  return (
    JSON.stringify(
      {
        version: CATALOG_VERSION,
        providers: PROVIDER_CATALOG,
      },
      null,
      2,
    ) + "\n"
  );
}

function main(): void {
  const expected = serializeLlmProviderCatalog();

  if (process.argv.includes("--check")) {
    let actual: string;
    try {
      actual = readFileSync(catalogPath, "utf-8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Could not read meta/llm-provider-catalog.json: ${message}`);
      process.exit(1);
    }

    if (actual !== expected) {
      console.error(
        "meta/llm-provider-catalog.json is out of date. Run `bun run scripts/generate-llm-provider-catalog.ts` from the repo root.",
      );
      process.exit(1);
    }

    return;
  }

  writeFileSync(catalogPath, expected, "utf-8");
}

if (basename(process.argv[1] ?? "") === "generate-llm-provider-catalog.ts") {
  main();
}

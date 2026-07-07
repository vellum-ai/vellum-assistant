#!/usr/bin/env bun
/**
 * Generate an OpenAPI 3.1 JSON specification from the gateway's route schemas.
 *
 * Route files export a `ROUTES` array with Zod `responseBody` / `requestBody`
 * schemas. This script imports them and calls zod-openapi's `createDocument()`.
 *
 * Usage:
 *   cd gateway && bun run scripts/generate-openapi.ts
 *   cd gateway && bun run generate:openapi
 *   cd gateway && bun run generate:openapi -- --check   # CI: fail if stale
 */

import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createDocument } from "zod-openapi";

import type { GatewayRouteDefinition } from "../src/http/routes/types.js";

// Import ROUTES from each route module that declares schemas.
// Add new route modules here as they adopt zod-openapi schemas.
import { ROUTES as credentialRequestRoutes } from "../src/http/routes/credential-requests.js";
import { ROUTES as featureFlagRoutes } from "../src/http/routes/feature-flags.js";

const ROOT = resolve(import.meta.dir, "..");
const OUTPUT_PATH = resolve(ROOT, "openapi.json");
const PKG_PATH = resolve(ROOT, "package.json");

// Collect all route definitions
const ALL_ROUTES: GatewayRouteDefinition[] = [
  ...credentialRequestRoutes,
  ...featureFlagRoutes,
];

// ---------------------------------------------------------------------------
// Spec builder
// ---------------------------------------------------------------------------

function buildSpec(version: string) {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of ALL_ROUTES) {
    if (!paths[route.path]) paths[route.path] = {};

    const parameters: Array<Record<string, unknown>> = [];
    if (route.pathParameters) {
      for (const param of route.pathParameters) {
        parameters.push({
          name: param.name,
          in: "path",
          required: true,
          schema: { type: "string" },
          ...(param.description ? { description: param.description } : {}),
        });
      }
    }

    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      summary: route.summary,
      tags: route.tags,
    };

    if (route.description) operation.description = route.description;
    if (parameters.length > 0) operation.parameters = parameters;

    if (route.requestBody) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": { schema: route.requestBody },
        },
      };
    }

    if (route.responseBody) {
      operation.responses = {
        "200": {
          description: "Successful response",
          content: {
            "application/json": { schema: route.responseBody },
          },
        },
      };
    } else {
      operation.responses = {
        "200": { description: "Successful response" },
      };
    }

    paths[route.path][route.method] = operation;
  }

  return createDocument({
    openapi: "3.1.0",
    info: {
      title: "Vellum Gateway API",
      version,
      description:
        "Auto-generated OpenAPI specification for the Vellum Gateway HTTP endpoints.",
    },
    servers: [{ url: "", description: "Same-origin (gateway)" }],
    paths,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const isCheck = process.argv.includes("--check");

  const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8")) as {
    version: string;
  };

  const spec = buildSpec(pkg.version);
  const output = JSON.stringify(spec, null, 2) + "\n";

  if (isCheck) {
    let existing: string;
    try {
      existing = await readFile(OUTPUT_PATH, "utf-8");
    } catch {
      console.error(
        `${OUTPUT_PATH} does not exist. Run: bun run generate:openapi`,
      );
      process.exit(1);
    }
    if (existing !== output) {
      console.error(
        "openapi.json is stale. Regenerate: bun run generate:openapi",
      );
      process.exit(1);
    }
    console.log("openapi.json is up to date.");
    return;
  }

  await writeFile(OUTPUT_PATH, output);
  console.log(`Wrote ${OUTPUT_PATH} (${ALL_ROUTES.length} routes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

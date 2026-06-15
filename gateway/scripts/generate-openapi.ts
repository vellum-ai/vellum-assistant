#!/usr/bin/env bun
/**
 * Generate an OpenAPI 3.1 JSON specification from the gateway's route schemas.
 *
 * Pipeline:
 *   1. Define route schemas with Zod `responseBody` / `requestBody`.
 *   2. Use zod-openapi's `createDocument()` to produce the spec.
 *   3. Write to openapi.json.
 *
 * Usage:
 *   cd gateway && bun run scripts/generate-openapi.ts
 *   cd gateway && bun run generate:openapi
 *   cd gateway && bun run generate:openapi -- --check   # CI: fail if stale
 */

import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";
import { createDocument } from "zod-openapi";

const ROOT = resolve(import.meta.dir, "..");
const OUTPUT_PATH = resolve(ROOT, "openapi.json");
const PKG_PATH = resolve(ROOT, "package.json");

// ---------------------------------------------------------------------------
// Route schemas
// ---------------------------------------------------------------------------

const FeatureFlagEntrySchema = z.object({
  key: z.string(),
  label: z.string(),
  enabled: z.union([z.boolean(), z.string()]),
  defaultEnabled: z.union([z.boolean(), z.string()]),
  description: z.string(),
});

const FeatureFlagsGetResponseSchema = z.object({
  flags: z.array(FeatureFlagEntrySchema),
});

const FeatureFlagPatchRequestSchema = z.object({
  enabled: z.union([z.boolean(), z.string()]),
});

const FeatureFlagPatchResponseSchema = z.object({
  key: z.string(),
  enabled: z.union([z.boolean(), z.string()]),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

interface RouteDefinition {
  path: string;
  method: "get" | "post" | "put" | "patch" | "delete";
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  responseBody?: z.ZodTypeAny;
  requestBody?: z.ZodTypeAny;
  pathParameters?: Array<{ name: string; description?: string }>;
}

const ROUTES: RouteDefinition[] = [
  {
    path: "/v1/feature-flags",
    method: "get",
    operationId: "featureFlagsGet",
    summary: "List all feature flags",
    description: "Returns all feature flags with their current values.",
    tags: ["feature-flags"],
    responseBody: FeatureFlagsGetResponseSchema,
  },
  {
    path: "/v1/feature-flags/{flag_key}",
    method: "patch",
    operationId: "featureFlagsPatch",
    summary: "Update a feature flag",
    description: "Set the enabled state of a single feature flag.",
    tags: ["feature-flags"],
    pathParameters: [
      { name: "flag_key", description: "The kebab-case flag identifier" },
    ],
    requestBody: FeatureFlagPatchRequestSchema,
    responseBody: FeatureFlagPatchResponseSchema,
  },
];

// ---------------------------------------------------------------------------
// Spec builder
// ---------------------------------------------------------------------------

function buildSpec(version: string) {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of ROUTES) {
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
    servers: [
      {
        url: "",
        description: "Same-origin (gateway)",
      },
    ],
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
  console.log(`Wrote ${OUTPUT_PATH} (${ROUTES.length} routes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

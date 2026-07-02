#!/usr/bin/env bun
/**
 * Generate a minimal OpenAPI 3.0 YAML specification from the assistant's
 * HTTP route definitions.
 *
 * Pipeline:
 *   1. Programmatically import every route module under src/runtime/routes/
 *      and collect all exported ROUTES arrays — no regex, no source-text parsing.
 *   2. Combine with pre-auth / non-v1 routes.
 *   3. Convert to OpenAPI path items.
 *   4. Write to openapi.yaml.
 *
 * Usage:
 *   cd assistant && bun run scripts/generate-openapi.ts
 *   cd assistant && bun run generate:openapi            # via npm script
 *   cd assistant && bun run generate:openapi -- --check  # CI: fail if stale
 */

import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { stringify } from "yaml";
import { z } from "zod";
import type {
  oas31,
  ZodOpenApiOperationObject,
  ZodOpenApiPathsObject,
  ZodOpenApiResponseObject,
} from "zod-openapi";
import { createDocument } from "zod-openapi";

const ROOT = resolve(import.meta.dir, "..");
const ROUTES_DIR = join(ROOT, "src/runtime/routes");
const PLUGIN_DEFAULTS_DIR = join(ROOT, "src/plugins/defaults");
const OUTPUT_PATH = join(ROOT, "openapi.yaml");
const PKG_PATH = join(ROOT, "package.json");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RouteQueryParamSchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  required: z.boolean().optional(),
  description: z.string().optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Accepts either a Zod schema instance (has _zod property) or a plain
 * JSON-Schema-style object for backward compatibility with inline routes.
 */
const RouteBodySchemaSchema = z.any().refine(
  (v): v is z.ZodType | oas31.SchemaObject =>
    v != null &&
    typeof v === "object" &&
    // Zod schema instance (Zod 4 uses _zod branded property)
    ("_zod" in v ||
      // Plain JSON Schema fallback
      "type" in v),
  { message: "Expected a Zod schema or a plain JSON Schema object" },
);

/** Explicit `{ contentType, schema }` body for non-JSON media types. */
const RouteBodyWithContentTypeSchema = z.object({
  contentType: z.string(),
  /** Zod schema OR plain JSON Schema fragment. */
  schema: z.any(),
});

/**
 * A route's request or success-response body: either a bare Zod/JSON schema
 * (advertised as `application/json`) or an explicit `{ contentType, schema }`
 * pair for non-JSON media (e.g. an `application/octet-stream` upload or binary
 * download).
 */
const RouteContentBodySchema = z.union([
  RouteBodyWithContentTypeSchema,
  RouteBodySchemaSchema,
]);

const RouteAdditionalResponseSchema = z.object({
  description: z.string(),
  schema: z.any().optional(),
});

const RouteEntrySchema = z.object({
  method: z.string(),
  /** Endpoint path relative to /v1/ (e.g. "conversations/:id"). */
  endpoint: z.string(),
  /** Short summary for OpenAPI operation. */
  summary: z.string().optional(),
  /** Longer description for OpenAPI operation. */
  description: z.string().optional(),
  /** Grouping tags. */
  tags: z.array(z.string()).optional(),
  /** Query parameter definitions. */
  queryParams: z.array(RouteQueryParamSchema).optional(),
  /** Request body: a bare Zod/JSON schema (JSON) or `{ contentType, schema }`. */
  requestBody: RouteContentBodySchema.optional(),
  /** Success response body: a bare Zod/JSON schema (JSON) or `{ contentType, schema }`. */
  responseBody: RouteContentBodySchema.optional(),
  /** HTTP status code for the success response. Defaults to "200".
   * Callable responseStatus values (used at runtime) are ignored here. */
  responseStatus: z.preprocess(
    (v) => (typeof v === "string" ? v : undefined),
    z.string().optional(),
  ),
  /** Extra response codes documented in the spec. */
  additionalResponses: z
    .record(z.string(), RouteAdditionalResponseSchema)
    .optional(),
  /** Source module filename, used for auto-deriving tags. */
  sourceModule: z.string().optional(),
});

type RouteEntry = z.infer<typeof RouteEntrySchema>;

type ContentSchema = z.ZodType | oas31.SchemaObject;

type HttpStatusCode = `${1 | 2 | 3 | 4 | 5}${string}`;

function toHttpStatus(status: string): HttpStatusCode {
  if (!/^[1-5]\d{2}$/.test(status)) {
    throw new Error(`Invalid HTTP status code: ${status}`);
  }
  return status as HttpStatusCode;
}

/**
 * Resolve a schema source to a value suitable for zod-openapi's
 * `schema` field. If it's a Zod schema, pass it through directly (so
 * createDocument can extract components and produce $ref pointers).
 * For plain JSON Schema objects (backward compat), pass as-is —
 * createDocument accepts SchemaObject too.
 */
function resolveSchemaForDocument(schemaSource: unknown): ContentSchema {
  if (schemaSource == null || typeof schemaSource !== "object") {
    return { type: "object" } satisfies oas31.SchemaObject;
  }
  return schemaSource as ContentSchema;
}

// ---------------------------------------------------------------------------
// Programmatic route extraction
// ---------------------------------------------------------------------------

/**
 * Directories holding `RouteDefinition` modules: the host `runtime/routes`
 * tree plus every default plugin's `routes/` subdirectory. A default plugin
 * that owns model-facing HTTP/IPC routes defines them under
 * `plugins/defaults/<plugin>/routes/` and the host route aggregator registers
 * them at runtime; the generator scans those dirs too so the spec stays
 * complete no matter which package a route lives in. Sorted for reproducible
 * output (see {@link collectRoutesFromModules}).
 */
async function routeModuleDirs(): Promise<string[]> {
  const dirs = [ROUTES_DIR];
  for (const entry of await readdir(PLUGIN_DEFAULTS_DIR, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const routesDir = join(PLUGIN_DEFAULTS_DIR, entry.name, "routes");
    if (existsSync(routesDir)) dirs.push(routesDir);
  }
  return dirs.sort();
}

/**
 * Dynamically import every route module under each {@link routeModuleDirs}
 * entry and collect all exported `ROUTES` / `*_ROUTES` arrays. Each route
 * module exports a `RouteDefinition[]`; new modules are picked up without
 * manual updates.
 */
async function collectRoutesFromModules(): Promise<RouteEntry[]> {
  const routes: RouteEntry[] = [];

  for (const dir of await routeModuleDirs()) {
    // Skip the `index.ts` barrel: it re-exports every other route module's
    // ROUTES into a single combined array, so importing it would double-count
    // every entry. The duplicate `method:endpoint` keys are deduped later by
    // first-seen, but the surviving entry's `sourceModule` (used to derive
    // OpenAPI `tags`) depends on `readdir` order — which is filesystem
    // dependent and diverges between local sandbox and the CI runner, making
    // the generator non-reproducible. Sort the file list as well so directory
    // entry order can never affect the output.
    const files = (await readdir(dir, { recursive: true }))
      .filter(
        (f) =>
          typeof f === "string" &&
          f.endsWith(".ts") &&
          !f.endsWith(".test.ts") &&
          !f.endsWith(".benchmark.test.ts") &&
          !f.includes("node_modules") &&
          f !== "index.ts" &&
          !f.endsWith("/index.ts"),
      )
      .sort();

    for (const file of files) {
      const filePath = join(dir, file);
      let mod: Record<string, unknown>;
      try {
        mod = (await import(filePath)) as Record<string, unknown>;
      } catch (err) {
        console.warn(
          `Warning: could not import ${file}: ${err instanceof Error ? err.message : err}`,
        );
        continue;
      }

      // Collect every export whose name is `ROUTES` or ends in `_ROUTES`.
      // A handful of route files (e.g. `channel-route-definitions.ts`,
      // `contact-prompt-routes.ts`) export under domain-prefixed names like
      // `CHANNEL_ROUTES` and `CONTACT_PROMPT_ROUTES` rather than the
      // canonical `ROUTES`. Without this fan-out the only way those routes
      // reached the spec was via the `index.ts` barrel — which is excluded
      // above for reproducibility.
      const exportNames = Object.keys(mod)
        .filter((k) => k === "ROUTES" || k.endsWith("_ROUTES"))
        .sort();
      for (const name of exportNames) {
        const arr = mod[name];
        if (!Array.isArray(arr)) continue;
        for (const raw of arr) {
          const result = RouteEntrySchema.safeParse({
            ...(typeof raw === "object" && raw !== null ? raw : {}),
            sourceModule: file,
          });
          if (result.success) routes.push(result.data);
        }
      }
    }
  }

  return routes;
}

/**
 * Trivial liveness/startup probe response. `/healthz` is the k8s startup +
 * liveness target and stays intentionally minimal: a static `{ status, version }`
 * answered the instant the HTTP server is up, with zero DB/CES/lifecycle access.
 */
const trivialHealthSchema = z.object({
  status: z.string(),
  version: z.string(),
});

/**
 * Strict readiness probe response. `/readyz` gates on the daemon's synchronous
 * startup latches (`isStartupComplete() && isDbReady()`), returning 503 with
 * `ready: false` until both are set, then a stable 200. `notReady` lists the
 * gates still failing (`"startup"`, `"db"`). CES is never consulted.
 */
const readyzSchema = z.object({
  status: z.string(),
  ready: z.boolean(),
  notReady: z.array(z.string()),
});

/**
 * Top-level routes outside the /v1/ namespace.
 * These are added to the spec separately.
 */
const NON_V1_ROUTES: Array<{
  method: string;
  path: string;
  summary?: string;
  description?: string;
  responseBody?: z.ZodType;
  additionalResponses?: Record<
    string,
    { description: string; schema?: unknown }
  >;
}> = [
  {
    method: "GET",
    path: "/healthz",
    summary: "Liveness probe",
    description:
      "Trivial liveness/startup probe. Returns { status, version } the instant " +
      "the HTTP server is up, with zero DB/CES/lifecycle access.",
    responseBody: trivialHealthSchema,
  },
  {
    method: "GET",
    path: "/readyz",
    summary: "Readiness probe",
    description:
      "Strict readiness probe. Returns 503 with { status, ready, notReady } until " +
      "the daemon's synchronous startup latches (isStartupComplete() && isDbReady()) " +
      "are set, then a stable 200. notReady lists the gates still failing " +
      '("startup", "db"). CES is informational and never gates readiness.',
    responseBody: readyzSchema,
    additionalResponses: {
      "503": {
        description: "Not ready — startup incomplete or database not ready.",
        schema: readyzSchema,
      },
    },
  },
  { method: "GET", path: "/pages/{id}" },
];

// ---------------------------------------------------------------------------
// OpenAPI helpers
// ---------------------------------------------------------------------------

/** Convert route endpoint `:param` / `:param*` syntax to OpenAPI `{param}`. */
function toOpenApiPath(endpoint: string): string {
  return (
    "/v1/" + endpoint.replace(/:(\w+)\*/g, "{$1}").replace(/:(\w+)/g, "{$1}")
  );
}

/** Derive a unique operationId from the endpoint and HTTP method. */
function toOperationId(endpoint: string, method: string): string {
  const slug = endpoint
    .replace(/:(\w+)\*/g, "by_$1")
    .replace(/:(\w+)/g, "by_$1")
    .replace(/[/]/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "");
  return `${slug}_${method.toLowerCase()}`;
}

/** Extract path parameter names from an OpenAPI-style path. */
function extractPathParams(openApiPath: string): string[] {
  const params: string[] = [];
  const re = /\{(\w+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(openApiPath)) !== null) {
    params.push(m[1]);
  }
  return params;
}

// ---------------------------------------------------------------------------
// Spec builder
// ---------------------------------------------------------------------------

interface OpenApiParameter {
  name: string;
  in: string;
  required: boolean;
  schema: { type: string };
  description?: string;
}

/**
 * Resolve a body declaration (request or success response) into its media type
 * and the schema source to convert. A bare Zod/JSON schema is advertised as
 * `application/json`; the explicit `{ contentType, schema }` form carries its
 * own media type (e.g. `application/octet-stream` for binary bodies).
 */
function hasContentType(
  body: unknown,
): body is { contentType: string; schema: unknown } {
  return typeof body === "object" && body !== null && "contentType" in body;
}

function resolveBodyContent(body: unknown): {
  contentType: string;
  schemaSource: unknown;
} {
  if (hasContentType(body)) {
    return { contentType: body.contentType, schemaSource: body.schema };
  }
  return { contentType: "application/json", schemaSource: body };
}

/** Derive a tag name from a route module filename (e.g. "secret-routes.ts" → "secrets"). */
function deriveTagFromModule(filename: string): string {
  // Strip directory prefix and extension
  const base = filename.replace(/^.*[\/]/, "").replace(/\.ts$/, "");
  // Remove trailing "-routes" suffix
  return base.replace(/-routes$/, "");
}

function buildSpec(
  routes: RouteEntry[],
  version: string,
): Record<string, unknown> {
  // Deduplicate by path+method
  const seen = new Set<string>();
  const uniqueRoutes: Array<{
    path: string;
    method: string;
    endpoint: string;
    entry: RouteEntry;
  }> = [];

  // Non-v1 routes first
  for (const r of NON_V1_ROUTES) {
    const key = `${r.method}:${r.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueRoutes.push({
        path: r.path,
        method: r.method,
        endpoint: r.path,
        entry: {
          method: r.method,
          endpoint: r.path,
          ...(r.summary ? { summary: r.summary } : {}),
          ...(r.description ? { description: r.description } : {}),
          ...(r.responseBody ? { responseBody: r.responseBody } : {}),
          ...(r.additionalResponses
            ? { additionalResponses: r.additionalResponses }
            : {}),
        },
      });
    }
  }

  // v1 routes
  for (const r of routes) {
    const openApiPath = toOpenApiPath(r.endpoint);
    const key = `${r.method}:${openApiPath}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueRoutes.push({
        path: openApiPath,
        method: r.method,
        endpoint: r.endpoint,
        entry: r,
      });
    }
  }

  // Sort by path, then by method for deterministic output
  uniqueRoutes.sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    return a.method.localeCompare(b.method);
  });

  // Build paths object for zod-openapi's createDocument
  const paths: ZodOpenApiPathsObject = {};
  for (const route of uniqueRoutes) {
    if (!paths[route.path]) {
      paths[route.path] = {};
    }

    const methodLower = route.method.toLowerCase() as
      | "get"
      | "post"
      | "put"
      | "patch"
      | "delete"
      | "options"
      | "head"
      | "trace";
    const operationId = route.path.startsWith("/v1/")
      ? toOperationId(route.endpoint, route.method)
      : route.path.replace(/^\//, "").replace(/[/{}\-]/g, "_") +
        `_${methodLower}`;

    const { entry } = route;

    // Build parameters: path params + query params from metadata
    const pathParams = extractPathParams(route.path);
    const parameters: OpenApiParameter[] = pathParams.map((name) => ({
      name,
      in: "path" as const,
      required: true,
      schema: { type: "string" },
    }));

    if (entry.queryParams) {
      for (const qp of entry.queryParams) {
        parameters.push({
          name: qp.name,
          in: "query",
          required: qp.required ?? false,
          schema: qp.schema ?? { type: qp.type ?? "string" },
          ...(qp.description ? { description: qp.description } : {}),
        });
      }
    }

    // Determine tags: explicit tags > auto-derived from source module
    const tags: string[] | undefined =
      entry.tags && entry.tags.length > 0
        ? entry.tags
        : entry.sourceModule
          ? [deriveTagFromModule(entry.sourceModule)]
          : undefined;

    // Build the operation. Default success status is 200; async endpoints
    // that enqueue a job and return immediately set responseStatus: "202"
    // so the generated spec matches the handler's actual response code.
    const successStatus = toHttpStatus(entry.responseStatus ?? "200");
    let successResponse: ZodOpenApiResponseObject = {
      description: "Successful response",
    };
    if (entry.responseBody) {
      const { contentType, schemaSource } = resolveBodyContent(
        entry.responseBody,
      );
      successResponse = {
        description: "Successful response",
        content: {
          [contentType]: {
            schema: resolveSchemaForDocument(schemaSource),
          },
        },
      };
    }
    const operation: ZodOpenApiOperationObject = {
      operationId,
      ...(entry.summary ? { summary: entry.summary } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      ...(tags ? { tags } : {}),
      responses: {
        [successStatus]: successResponse,
      },
    };

    if (parameters.length > 0) {
      operation.parameters = parameters;
    }

    if (entry.requestBody) {
      const { contentType, schemaSource } = resolveBodyContent(
        entry.requestBody,
      );
      operation.requestBody = {
        required: true,
        content: {
          [contentType]: {
            schema: resolveSchemaForDocument(schemaSource),
          },
        },
      };
    }

    // Extra documented response variants (e.g. 502 fetch_failed).
    if (entry.additionalResponses) {
      for (const [status, resp] of Object.entries(entry.additionalResponses)) {
        operation.responses[toHttpStatus(status)] = {
          description: resp.description,
          ...(resp.schema
            ? {
                content: {
                  "application/json": {
                    schema: resolveSchemaForDocument(resp.schema),
                  },
                },
              }
            : {}),
        };
      }
    }

    paths[route.path][methodLower] = operation;
  }

  return createDocument({
    openapi: "3.1.0",
    info: {
      title: "Vellum Assistant API",
      version,
      description:
        "Auto-generated OpenAPI specification for the Vellum Assistant runtime HTTP server.",
    },
    servers: [
      {
        url: "http://127.0.0.1:7821",
        description: "Local assistant (default port)",
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

  // Read package version
  const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8")) as {
    version: string;
  };
  const version = pkg.version;

  // Collect routes programmatically from route modules
  const moduleRoutes = await collectRoutesFromModules();

  // Combine all route sources
  const allRoutes: RouteEntry[] = moduleRoutes;

  // Build the spec
  const spec = buildSpec(allRoutes, version);
  const rawYaml =
    "# Auto-generated by scripts/generate-openapi.ts — DO NOT EDIT\n" +
    "# Regenerate: cd assistant && bun run generate:openapi\n" +
    stringify(spec, { lineWidth: 120 });

  // Format with prettier so the output matches what the pre-commit hook produces.
  const prettierProc = Bun.spawn(["bunx", "prettier", "--parser", "yaml"], {
    stdin: new Blob([rawYaml]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [yamlOutput, prettierExitCode] = await Promise.all([
    new Response(prettierProc.stdout).text(),
    prettierProc.exited,
  ]);
  if (prettierExitCode !== 0) {
    const stderr = await new Response(prettierProc.stderr).text();
    console.error(`prettier exited with code ${prettierExitCode}: ${stderr}`);
    process.exit(1);
  }

  if (isCheck) {
    let existing: string;
    try {
      existing = await readFile(OUTPUT_PATH, "utf-8");
    } catch {
      console.error(
        "openapi.yaml does not exist. Run: bun run generate:openapi",
      );
      process.exit(1);
    }
    if (existing !== yamlOutput) {
      console.error("openapi.yaml is stale. Run: bun run generate:openapi");
      // Emit the first byte-level divergence and a windowed diff around it
      // so CI logs are actionable without a follow-up local repro.
      const maxLen = Math.max(existing.length, yamlOutput.length);
      let firstDiff = -1;
      for (let i = 0; i < maxLen; i++) {
        if (existing[i] !== yamlOutput[i]) {
          firstDiff = i;
          break;
        }
      }
      if (firstDiff >= 0) {
        const lineNo =
          (existing.slice(0, firstDiff).match(/\n/g) ?? []).length + 1;
        const winStart = Math.max(0, firstDiff - 120);
        const winEnd = Math.min(maxLen, firstDiff + 120);
        console.error(
          `First divergence at byte ${firstDiff} (~line ${lineNo}):`,
        );
        console.error(`  existing[${winStart}..${winEnd}]:`);
        console.error(
          `    ${JSON.stringify(existing.slice(winStart, winEnd))}`,
        );
        console.error(`  generated[${winStart}..${winEnd}]:`);
        console.error(
          `    ${JSON.stringify(yamlOutput.slice(winStart, winEnd))}`,
        );
      }
      // Also flag which path operations are present in one but not the other —
      // the common failure mode is a missing or duplicated route entry, and
      // the path keys are the actionable thing for the human reading the log.
      const pathsRe = /^\s\s(\/\S+):/gm;
      const existingPaths = new Set(
        Array.from(existing.matchAll(pathsRe), (m) => m[1]),
      );
      const generatedPaths = new Set(
        Array.from(yamlOutput.matchAll(pathsRe), (m) => m[1]),
      );
      const inExistingOnly = [...existingPaths].filter(
        (p) => !generatedPaths.has(p),
      );
      const inGeneratedOnly = [...generatedPaths].filter(
        (p) => !existingPaths.has(p),
      );
      if (inExistingOnly.length || inGeneratedOnly.length) {
        console.error(
          `Path set drift: existing has ${existingPaths.size} paths, generated has ${generatedPaths.size}`,
        );
        if (inGeneratedOnly.length) {
          console.error(`  Only in generated (missing from committed yaml):`);
          for (const p of inGeneratedOnly.slice(0, 20))
            console.error(`    + ${p}`);
        }
        if (inExistingOnly.length) {
          console.error(
            `  Only in existing (stale entries in committed yaml):`,
          );
          for (const p of inExistingOnly.slice(0, 20))
            console.error(`    - ${p}`);
        }
      }
      process.exit(1);
    }
    console.log("openapi.yaml is up to date.");
    return;
  }

  await writeFile(OUTPUT_PATH, yamlOutput);

  // Count stats
  const paths = spec.paths ?? {};
  const pathCount = Object.keys(paths).length;
  const operationCount = Object.values(paths).reduce(
    (n, methods) => n + Object.keys(methods ?? {}).length,
    0,
  );

  console.log(`Generated ${OUTPUT_PATH}`);
  console.log(`  ${pathCount} paths, ${operationCount} operations`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

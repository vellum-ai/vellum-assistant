import { createHash } from "node:crypto";
import { validateHeaderName, validateHeaderValue } from "node:http";

import { z } from "zod";

import { isLoopbackAddress } from "../runtime/middleware/auth.js";

export const STANDARD_PLUGIN_SCHEMA_URL =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const STANDARD_MCP_SCHEMA_URL =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

// Agent Plugins 1.0.0, sections 5 and 8. Unknown extensions are opaque.
export const standardPluginManifestSchema = z.object({
  $schema: z.literal(STANDARD_PLUGIN_SCHEMA_URL),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$(?![\s\S])/),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z
    .strictObject({
      name: z.string().optional(),
      email: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

function isStandardEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return (
      /^https?:\/\//i.test(value) &&
      !/[\u0000-\u0020\\]/.test(value) &&
      !/^https?:\/\/[^/?#]*@/i.test(value) &&
      !url.username &&
      !url.password &&
      !value.includes("#") &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          (host === "localhost" || isLoopbackAddress(host))))
    );
  } catch {
    return false;
  }
}

const headersSchema = z
  .record(z.string(), z.string())
  .superRefine((headers, ctx) => {
    const names = new Set<string>();
    for (const [name, value] of Object.entries(headers)) {
      try {
        validateHeaderName(name);
        validateHeaderValue(name, value);
        if (names.has(name.toLowerCase())) {
          throw new Error("Duplicate header name");
        }
        names.add(name.toLowerCase());
      } catch {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: "Invalid or duplicate HTTP header",
        });
      }
    }
  });

const remoteFields = {
  url: z
    .string()
    .refine(
      isStandardEndpoint,
      "Expected an absolute HTTPS endpoint, or loopback HTTP, without user information or fragment",
    ),
  headers: headersSchema.optional(),
};

export const standardStreamableHttpServerSchema = z.strictObject({
  type: z.literal("streamable-http"),
  ...remoteFields,
});

export const standardMcpServerSchema = z.discriminatedUnion("type", [
  standardStreamableHttpServerSchema,
  z.strictObject({ type: z.literal("sse"), ...remoteFields }),
  z.strictObject({
    type: z.literal("stdio"),
    command: z
      .string()
      .min(1)
      .refine(
        (value) =>
          !/[\s\u0000${}]/.test(value) &&
          (value.startsWith("./") || !/[/\\:]/.test(value)),
        "Expected a bare executable token or a plugin-relative executable",
      ),
    args: z.array(z.string()).optional(),
    env: z
      .record(z.string(), z.string())
      .refine(
        (value) =>
          !Object.hasOwn(value, "PLUGIN_ROOT") &&
          !Object.hasOwn(value, "PLUGIN_DATA"),
        "Plugin path environment variables are client-managed",
      )
      .optional(),
    cwd: z
      .string()
      .regex(/^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/)
      .optional(),
  }),
]);

const mcpEnvelopeSchema = z.strictObject({
  $schema: z.literal(STANDARD_MCP_SCHEMA_URL),
  mcpServers: z.record(z.string(), z.unknown()),
});

export type StandardPluginManifest = z.infer<
  typeof standardPluginManifestSchema
>;
export type StandardMcpServer = z.infer<typeof standardMcpServerSchema>;
export type StandardStreamableHttpServer = z.infer<
  typeof standardStreamableHttpServerSchema
>;
export type StandardMcpDocument = z.infer<typeof mcpEnvelopeSchema>;
export interface StandardDocuments {
  plugin: StandardPluginManifest;
  mcp?: StandardMcpDocument;
}

export interface StandardDefinitionIssue {
  code:
    | "invalid_plugin"
    | "invalid_mcp"
    | "invalid_server"
    | "unsupported_transport"
    | "ignored_manifest_field"
    | "ignored_extensions"
    | "read_error"
    | "path_escape"
    | "invalid_json";
  message: string;
  serverKey?: string;
}

export type StandardDefinitionsResult =
  | {
      ok: true;
      documents: StandardDocuments;
      servers: Record<string, StandardStreamableHttpServer>;
      issues: StandardDefinitionIssue[];
    }
  | { ok: false; issues: StandardDefinitionIssue[] };

/** Reads the catalog's selected MCP component; it never installs a plugin. */
export function parseStandardDefinitions(
  plugin: unknown,
  mcp?: unknown,
): StandardDefinitionsResult {
  const issues: StandardDefinitionIssue[] = [];
  let input = plugin;
  if (plugin !== null && typeof plugin === "object" && !Array.isArray(plugin)) {
    const fields = { ...plugin } as Record<string, unknown>;
    for (const key of Object.keys(fields)) {
      if (!Object.hasOwn(standardPluginManifestSchema.shape, key)) {
        issues.push({
          code: "ignored_manifest_field",
          message: `Ignoring unknown plugin field: ${key}`,
        });
      }
    }
    if (
      Object.hasOwn(fields, "extensions") &&
      (fields.extensions === null ||
        typeof fields.extensions !== "object" ||
        Array.isArray(fields.extensions))
    ) {
      issues.push({
        code: "ignored_extensions",
        message: "Ignoring non-object plugin extensions",
      });
      delete fields.extensions;
    }
    input = fields;
  }
  const manifest = standardPluginManifestSchema.safeParse(input);
  if (!manifest.success) {
    return {
      ok: false,
      issues: [
        ...issues,
        { code: "invalid_plugin", message: manifest.error.message },
      ],
    };
  }
  if (mcp === undefined) {
    return {
      ok: true,
      documents: { plugin: manifest.data },
      servers: {},
      issues,
    };
  }
  const document = mcpEnvelopeSchema.safeParse(mcp);
  if (!document.success) {
    return {
      ok: false,
      issues: [
        ...issues,
        { code: "invalid_mcp", message: document.error.message },
      ],
    };
  }
  const servers: Record<string, StandardStreamableHttpServer> =
    Object.create(null);
  for (const [serverKey, value] of Object.entries(document.data.mcpServers)) {
    const server = standardMcpServerSchema.safeParse(value);
    if (!server.success) {
      issues.push({
        code: "invalid_server",
        serverKey,
        message: server.error.message,
      });
    } else if (server.data.type !== "streamable-http") {
      issues.push({
        code: "unsupported_transport",
        serverKey,
        message: `Catalog connections do not support ${server.data.type}`,
      });
    } else {
      servers[serverKey] = server.data;
    }
  }
  return {
    ok: true,
    documents: { plugin: manifest.data, mcp: document.data },
    servers,
    issues,
  };
}

export function standardDefinitionDigest(documents: StandardDocuments): string {
  return createHash("sha256").update(JSON.stringify(documents)).digest("hex");
}

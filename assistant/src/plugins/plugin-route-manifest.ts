import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { PeerOperationKindSchema } from "../plugin-api/verified-peer-context.js";

export const PLUGIN_ROUTE_MANIFEST_PATH = join("routes", "manifest.json");

const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_ROUTES = 256;
const ROUTE_PATH_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._~/-]*$/;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isActorMutationScope(scope: string): boolean {
  return (
    scope.endsWith(".write") ||
    scope === "local.all" ||
    scope === "speech.relay"
  );
}

export const PluginRouteMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export const PluginRouteScopeSchema = z.enum([
  "chat.read",
  "chat.write",
  "approval.read",
  "approval.write",
  "settings.read",
  "settings.write",
  "attachments.read",
  "attachments.write",
  "calls.read",
  "calls.write",
  "ingress.write",
  "internal.write",
  "feature_flags.read",
  "feature_flags.write",
  "speech.relay",
  "local.all",
]);

const ActorRouteAuthorizationSchema = z
  .object({
    principal: z.literal("actor"),
    requiredScopes: z.array(PluginRouteScopeSchema).min(1).max(8),
  })
  .strict();

const AssistantPeerRouteAuthorizationSchema = z
  .object({
    principal: z.literal("assistant_peer"),
    operationKinds: z.array(PeerOperationKindSchema).min(1).max(32).optional(),
  })
  .strict();

export const PluginRouteAuthorizationSchema = z.discriminatedUnion(
  "principal",
  [ActorRouteAuthorizationSchema, AssistantPeerRouteAuthorizationSchema],
);

export const PluginRouteDeclarationSchema = z
  .object({
    path: z.string().min(1).max(240).regex(ROUTE_PATH_PATTERN),
    method: PluginRouteMethodSchema,
    authorization: PluginRouteAuthorizationSchema,
  })
  .strict()
  .superRefine((route, ctx) => {
    if (
      route.path.startsWith("/") ||
      route.path.endsWith("/") ||
      route.path.split("/").some((segment) => segment === "..")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "route paths must be normalized relative paths",
      });
    }
    if (
      MUTATING_METHODS.has(route.method) &&
      route.authorization.principal === "actor" &&
      !route.authorization.requiredScopes.some(isActorMutationScope)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["authorization", "requiredScopes"],
        message: "mutating actor routes require a write or action scope",
      });
    }
  });

export const PluginRouteManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    routes: z.array(PluginRouteDeclarationSchema).max(MAX_ROUTES),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    for (let index = 0; index < manifest.routes.length; index += 1) {
      const route = manifest.routes[index];
      const key = `${route.method} ${route.path}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["routes", index],
          message: `duplicate route declaration: ${key}`,
        });
      }
      seen.add(key);
    }
  });

export type PluginRouteMethod = z.infer<typeof PluginRouteMethodSchema>;
export type PluginRouteScope = z.infer<typeof PluginRouteScopeSchema>;
export type PluginRouteAuthorization = z.infer<
  typeof PluginRouteAuthorizationSchema
>;
export type PluginRouteDeclaration = z.infer<
  typeof PluginRouteDeclarationSchema
>;
export type PluginRouteManifest = z.infer<typeof PluginRouteManifestSchema>;

export type PluginRouteManifestResult =
  | { readonly kind: "legacy" }
  | {
      readonly kind: "valid";
      readonly manifest: PluginRouteManifest;
    }
  | { readonly kind: "invalid"; readonly reason: string };

interface CachedManifest {
  readonly contentSignature: string;
  readonly result: PluginRouteManifestResult;
}

const cache = new Map<string, CachedManifest>();

function getPluginRouteManifestPath(pluginDir: string): string {
  return join(pluginDir, PLUGIN_ROUTE_MANIFEST_PATH);
}

export function readPluginRouteManifest(
  pluginDir: string,
): PluginRouteManifestResult {
  const manifestPath = getPluginRouteManifestPath(pluginDir);
  if (!existsSync(manifestPath)) {
    return { kind: "legacy" };
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(manifestPath);
  } catch (err) {
    return {
      kind: "invalid",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  let result: PluginRouteManifestResult;
  let contentSignature = `${stat.dev}:${stat.ino}:${stat.size}`;
  if (!stat.isFile()) {
    result = { kind: "invalid", reason: "route manifest must be a file" };
  } else if (stat.size > MAX_MANIFEST_BYTES) {
    result = {
      kind: "invalid",
      reason: `route manifest exceeds ${MAX_MANIFEST_BYTES} bytes`,
    };
  } else {
    try {
      const contents = readFileSync(manifestPath);
      contentSignature = createHash("sha256").update(contents).digest("hex");
      const cached = cache.get(pluginDir);
      if (cached?.contentSignature === contentSignature) {
        return cached.result;
      }
      const parsed = PluginRouteManifestSchema.safeParse(
        JSON.parse(contents.toString("utf8")),
      );
      result = parsed.success
        ? { kind: "valid", manifest: parsed.data }
        : { kind: "invalid", reason: parsed.error.message };
    } catch (err) {
      result = {
        kind: "invalid",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  cache.set(pluginDir, { contentSignature, result });
  return result;
}

export function findPluginRouteDeclaration(
  manifest: PluginRouteManifest,
  path: string,
  method: string,
): PluginRouteDeclaration | undefined {
  return manifest.routes.find(
    (route) => route.path === path && route.method === method,
  );
}

export function resetPluginRouteManifestCacheForTests(): void {
  cache.clear();
}

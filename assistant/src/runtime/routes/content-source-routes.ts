/**
 * Route definitions for content-source configuration.
 *
 * POST /v1/content-source — validate and persist a content source URL as sidecar
 *
 * Uses policyKey: "secrets" — writes workspace data, same policy tier as
 * the existing secrets routes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import { getWorkspaceDir } from "../../util/platform.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeSidecar(relPath: string, data: Record<string, unknown>): void {
  const workspaceDir = getWorkspaceDir();
  const absPath = join(workspaceDir, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, JSON.stringify(data, null, 2), "utf-8");
}

function validateUrl(
  raw: string,
): { ok: true; normalized: string } | { ok: false; error: "invalid_url" } {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "invalid_url" };
  }
  parsed.username = "";
  parsed.password = "";
  return { ok: true, normalized: parsed.href };
}

// ---------------------------------------------------------------------------
// POST /v1/content-source
// ---------------------------------------------------------------------------

function handleContentSource(args: RouteHandlerArgs): Record<string, unknown> {
  const rawUrl = typeof args.body?.url === "string" ? args.body.url : "";

  const result = validateUrl(rawUrl);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  writeSidecar("data/content-source.json", { url: result.normalized });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "content_source_set",
    endpoint: "content-source",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Validate and persist a content source URL",
    requestBody: z.object({ url: z.string() }),
    handler: handleContentSource,
  },
];

/**
 * Route definitions for Sanity CMS connection management.
 *
 * POST /v1/sanity/discover — project/dataset discovery using the stored API token
 * POST /v1/sanity/connect  — finalise connection by writing the sidecar file
 *
 * Both routes use policyKey: "secrets" — they read credentials and write
 * workspace data, the same policy tier as the existing secrets routes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getStoredToken(): Promise<string | undefined> {
  return getSecureKeyAsync(credentialKey("sanity", "api_token"));
}

function writeSidecar(relPath: string, data: Record<string, unknown>): void {
  const workspaceDir = getWorkspaceDir();
  const absPath = join(workspaceDir, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, JSON.stringify(data, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// POST /v1/sanity/discover
// ---------------------------------------------------------------------------

async function handleDiscover(
  args: RouteHandlerArgs,
): Promise<Record<string, unknown>> {
  const token = await getStoredToken();
  if (!token) {
    return { error: "no_token" };
  }

  const projectId =
    typeof args.body?.projectId === "string" ? args.body.projectId : undefined;

  if (!projectId) {
    // List all projects this token has access to
    const response = await fetch("https://api.sanity.io/v2021-06-07/projects", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 401 || response.status === 403) {
      return { error: "token_scope_limited" };
    }

    if (!response.ok) {
      return { error: "discovery_failed" };
    }

    const raw = (await response.json()) as Array<{
      id: string;
      displayName?: string;
    }>;
    const projects = raw.map((p) => ({
      id: p.id,
      displayName: p.displayName ?? p.id,
    }));
    return { projects };
  }

  // List datasets for a specific project
  const response = await fetch(
    `https://api.sanity.io/v2021-06-07/projects/${projectId}/datasets`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (response.status === 401 || response.status === 403) {
    return { error: "token_scope_limited" };
  }

  if (!response.ok) {
    return { error: "discovery_failed" };
  }

  const raw = (await response.json()) as Array<{ name: string }>;
  const datasets = raw.map((d) => d.name);
  return { projectId, datasets };
}

// ---------------------------------------------------------------------------
// POST /v1/sanity/connect
// ---------------------------------------------------------------------------

async function handleConnect(
  args: RouteHandlerArgs,
): Promise<Record<string, unknown>> {
  const token = await getStoredToken();
  if (!token) {
    throw new BadRequestError(
      "Sanity API token not found. Store it first via POST /v1/secrets.",
    );
  }

  const projectId =
    typeof args.body?.projectId === "string" ? args.body.projectId.trim() : "";
  const dataset =
    typeof args.body?.dataset === "string" ? args.body.dataset.trim() : "";

  if (!projectId) {
    throw new BadRequestError(
      "projectId is required and must be a non-empty string",
    );
  }
  if (!dataset) {
    throw new BadRequestError(
      "dataset is required and must be a non-empty string",
    );
  }

  writeSidecar("data/sanity-connection.json", { projectId, dataset });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "sanity_discover",
    endpoint: "sanity/discover",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Discover Sanity projects and datasets using the stored API token",
    requestBody: z.object({ projectId: z.string().optional() }).optional(),
    handler: handleDiscover,
  },
  {
    operationId: "sanity_connect",
    endpoint: "sanity/connect",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Finalise Sanity connection and write sidecar file",
    requestBody: z.object({
      projectId: z.string(),
      dataset: z.string(),
    }),
    handler: handleConnect,
  },
];

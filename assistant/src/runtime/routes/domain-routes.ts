/**
 * Route handlers for the domain registration endpoints.
 *
 * POST /domain/register — register a custom subdomain for this assistant
 * GET  /domain/status   — get current domain registration status
 *
 * Both handlers own the full platform API call and config persistence.
 * The CLI commands are thin IPC wrappers that delegate here.
 */

import { getApexDomain } from "../../config/env.js";
import {
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import { VellumPlatformClient } from "../../platform/client.js";
import { RouteError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createClient(): Promise<VellumPlatformClient> {
  const client = await VellumPlatformClient.create();
  if (!client) {
    throw new RouteError(
      "Platform credentials not configured. Run: assistant platform connect",
      "PLATFORM_CREDENTIALS_MISSING",
      503,
    );
  }
  if (!client.platformAssistantId) {
    throw new RouteError(
      "Assistant ID not configured. Run: assistant platform connect",
      "ASSISTANT_ID_MISSING",
      503,
    );
  }
  return client;
}

async function extractErrorDetail(response: Response): Promise<string> {
  const respBody = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const detail =
    respBody.detail ??
    (Array.isArray(respBody.subdomain) ? respBody.subdomain[0] : undefined) ??
    `HTTP ${response.status}`;
  return String(detail);
}

function syncSubdomainToConfig(
  subdomain: string | undefined,
  domain: string | undefined,
): void {
  const apexDomain = getApexDomain();
  const resolvedSubdomain =
    subdomain ?? domain?.replace(`.${apexDomain}`, "") ?? undefined;
  if (resolvedSubdomain) {
    const raw = loadRawConfig();
    setNestedValue(raw, "platform.subdomain", resolvedSubdomain);
    saveRawConfig(raw);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleDomainRegister(args: RouteHandlerArgs): Promise<unknown> {
  const subdomain = (args.body as Record<string, unknown>)
    ?.subdomain as string | undefined;

  const client = await createClient();

  const body: Record<string, string> = {};
  if (subdomain) {
    body.subdomain = subdomain;
  }

  const response = await client.fetch(
    `/v1/assistants/${client.platformAssistantId}/domains/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const detail = await extractErrorDetail(response);
    throw new RouteError(detail, "PLATFORM_ERROR", response.status);
  }

  const data = (await response.json()) as {
    id: string;
    subdomain?: string;
    domain?: string;
    status?: string;
    verified?: boolean;
    created_at?: string;
    created?: string;
  };

  syncSubdomainToConfig(data.subdomain, data.domain);

  return data;
}

async function handleDomainStatus(_args: RouteHandlerArgs): Promise<unknown> {
  const client = await createClient();

  const response = await client.fetch(
    `/v1/assistants/${client.platformAssistantId}/domains/`,
  );

  if (!response.ok) {
    const respBody = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const detail = respBody.detail ?? `HTTP ${response.status}`;
    throw new RouteError(String(detail), "PLATFORM_ERROR", response.status);
  }

  const data = (await response.json()) as {
    results: {
      id: string;
      subdomain?: string;
      domain?: string;
      status?: string;
      verified?: boolean;
      created_at?: string;
      created?: string;
    }[];
  };

  const domains = data.results ?? [];

  if (domains.length > 0) {
    const first = domains[0];
    const apexDomain = getApexDomain();
    const sub =
      first.subdomain ?? first.domain?.replace(`.${apexDomain}`, "");
    if (sub) {
      const raw = loadRawConfig();
      const existing = (raw as Record<string, Record<string, unknown>>).platform
        ?.subdomain;
      if (existing !== sub) {
        setNestedValue(raw, "platform.subdomain", sub);
        saveRawConfig(raw);
      }
    }
  }

  return data;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "domain_register",
    endpoint: "domain/register",
    method: "POST",
    summary: "Register a custom subdomain",
    tags: ["domain"],
    handler: handleDomainRegister,
  },
  {
    operationId: "domain_status",
    endpoint: "domain/status",
    method: "GET",
    summary: "Get domain registration status",
    tags: ["domain"],
    handler: handleDomainStatus,
  },
];

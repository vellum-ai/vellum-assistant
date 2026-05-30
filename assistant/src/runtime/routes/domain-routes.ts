/**
 * Route handlers for domain registration and status.
 *
 * Delegates to the Vellum platform API for register/status and persists
 * the subdomain to local config so getAssistantDomain() can use it.
 */

import { getApexDomain } from "../../config/env.js";
import {
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import { VellumPlatformClient } from "../../platform/client.js";
import { LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, RouteError, UnauthorizedError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────

async function requireClient(): Promise<VellumPlatformClient> {
  const client = await VellumPlatformClient.create();
  if (!client) {
    throw new UnauthorizedError(
      "Platform credentials not configured. Run: assistant platform connect",
    );
  }
  if (!client.platformAssistantId) {
    throw new UnauthorizedError(
      "Assistant ID not configured. Run: assistant platform connect",
    );
  }
  return client;
}

// ── Handlers ──────────────────────────────────────────────────────────

async function handleDomainRegister({ body = {} }: RouteHandlerArgs) {
  const { subdomain, email_username } = body as {
    subdomain?: string;
    email_username?: string;
  };
  const client = await requireClient();
  const apexDomain = getApexDomain();

  const reqBody: Record<string, string> = {};
  if (subdomain) {
    reqBody.subdomain = subdomain;
  }
  if (email_username) {
    reqBody.email_username = email_username;
  }

  const response = await client.fetch(
    `/v1/assistants/${client.platformAssistantId}/domains/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    },
  );

  if (!response.ok) {
    const respBody = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const firstFieldError = ["subdomain", "email_username"].reduce<
      string | undefined
    >(
      (found, field) =>
        found ??
        (Array.isArray(respBody[field])
          ? (respBody[field][0] as string)
          : undefined),
      undefined,
    );
    const detail =
      respBody.detail ?? firstFieldError ?? `HTTP ${response.status}`;
    throw new BadRequestError(String(detail));
  }

  const data = (await response.json()) as {
    id: string;
    subdomain?: string;
    domain?: string;
    created_at?: string;
    created?: string;
    email_error?: { detail: string; code: string };
  };

  // Persist the subdomain to config so getAssistantDomain() can use it
  const registeredSubdomain =
    data.subdomain ??
    data.domain?.replace(`.${apexDomain}`, "") ??
    subdomain;
  if (registeredSubdomain) {
    const raw = loadRawConfig();
    setNestedValue(raw, "platform.subdomain", registeredSubdomain);
    saveRawConfig(raw);
  }

  return data;
}

async function handleDomainStatus(_args: RouteHandlerArgs) {
  const client = await requireClient();
  const apexDomain = getApexDomain();

  const response = await client.fetch(
    `/v1/assistants/${client.platformAssistantId}/domains/`,
  );

  if (!response.ok) {
    const respBody = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const detail = respBody.detail ?? `HTTP ${response.status}`;
    throw new RouteError(
      String(detail),
      "LIST_FAILED",
      response.status,
    );
  }

  const data = (await response.json()) as {
    results: {
      id: string;
      subdomain?: string;
      domain?: string;
      created_at?: string;
      created?: string;
    }[];
  };

  const domains = data.results ?? [];

  // Sync subdomain to config if not already cached
  if (domains.length > 0) {
    const first = domains[0];
    const sub =
      first.subdomain ?? first.domain?.replace(`.${apexDomain}`, "");
    if (sub) {
      const raw = loadRawConfig();
      const existing = (raw as Record<string, Record<string, unknown>>)
        .platform?.subdomain;
      if (existing !== sub) {
        setNestedValue(raw, "platform.subdomain", sub);
        saveRawConfig(raw);
      }
    }
  }

  return data;
}

async function handleDomainVerificationStatus({
  body = {},
}: RouteHandlerArgs) {
  const { domain_id } = body as { domain_id?: string };
  if (!domain_id) {
    throw new BadRequestError("domain_id is required");
  }
  const client = await requireClient();

  const response = await client.fetch(
    `/v1/assistants/${client.platformAssistantId}/domains/${domain_id}/verification-status/`,
  );

  if (!response.ok) {
    const respBody = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const detail = respBody.detail ?? `HTTP ${response.status}`;
    throw new RouteError(
      String(detail),
      "VERIFICATION_STATUS_FAILED",
      response.status,
    );
  }

  return (await response.json()) as {
    domain: string;
    status: string;
    message: string;
  };
}

// ── Route definitions ─────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "domain_register",
    endpoint: "domain/register",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleDomainRegister,
    summary: "Register a subdomain for this assistant",
    tags: ["domain"],
  },
  {
    operationId: "domain_status",
    endpoint: "domain/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleDomainStatus,
    summary: "Show domain registration and health",
    tags: ["domain"],
  },
  {
    operationId: "domain_verification_status",
    endpoint: "domain/verification-status",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleDomainVerificationStatus,
    summary: "Get live DNS verification status for a domain",
    tags: ["domain"],
  },
];

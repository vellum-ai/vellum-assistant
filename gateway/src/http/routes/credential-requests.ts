/**
 * Public HTTP surface for one-time credential-collection links.
 *
 * POST /v1/credential-requests/peek   — validate a token without consuming it
 * POST /v1/credential-requests/submit — atomically consume the token and
 *                                       forward the value to the daemon
 *
 * Both routes are unauthenticated (the token IS the credential to act) and
 * registered with `auth: "track-failures"` so repeated invalid tokens count
 * against the per-IP auth-failure limiter. The token always travels in the
 * request BODY — never the URL path — so it cannot land in access logs.
 *
 * Credential VALUES transit this handler in memory only: forwarded to the
 * daemon's `credentials_set` route over IPC, never persisted or logged here.
 */

import { z } from "zod";

import { hashInviteToken } from "@vellumai/gateway-client";
import {
  type CredentialRequestRow,
  CredentialRequestStore,
} from "../../db/credential-request-store.js";
import {
  ipcCallAssistant,
  IpcHandlerError,
} from "../../ipc/assistant-client.js";
import { getLogger } from "../../logger.js";
import { readLimitedBody } from "../read-limited-body.js";
import type { GatewayRouteDefinition } from "./types.js";

const log = getLogger("credential-requests");

const MAX_PEEK_BODY_BYTES = 2_048;
// Generous ceiling for pasted secrets (certs, multi-line keys) while still
// bounding unauthenticated ingress.
const MAX_SUBMIT_BODY_BYTES = 64 * 1_024;

type TokenLookup =
  | { outcome: "ok"; row: CredentialRequestRow }
  | { outcome: "invalid" | "expired" | "used" };

function jsonError(code: string, message: string, status: number): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

const PolicyJsonSchema = z.object({
  usageDescription: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  allowedDomains: z.array(z.string()).optional(),
  // Opaque passthrough — the daemon's credentials_set validates the shape.
  injectionTemplates: z.array(z.unknown()).optional(),
});

/**
 * Parse the mint-time policy stored on the row into `credentials_set` body
 * fields (`usageDescription` maps to that route's `description`). Malformed
 * policy is dropped — the value still stores without it.
 */
function parsePolicy(policyJson: string | null): Record<string, unknown> {
  if (!policyJson) {
    return {};
  }
  try {
    const parsed = PolicyJsonSchema.parse(JSON.parse(policyJson));
    return {
      ...(parsed.usageDescription !== undefined
        ? { description: parsed.usageDescription }
        : {}),
      ...(parsed.allowedTools !== undefined
        ? { allowedTools: parsed.allowedTools }
        : {}),
      ...(parsed.allowedDomains !== undefined
        ? { allowedDomains: parsed.allowedDomains }
        : {}),
      ...(parsed.injectionTemplates !== undefined
        ? { injectionTemplates: parsed.injectionTemplates }
        : {}),
    };
  } catch {
    return {};
  }
}

function lookupToken(token: string): TokenLookup {
  const store = new CredentialRequestStore();
  const row = store.findByTokenHash(hashInviteToken(token));
  if (!row || row.status === "revoked") {
    return { outcome: "invalid" };
  }
  if (row.status === "redeemed" || row.status === "redeeming") {
    return { outcome: "used" };
  }
  if (row.expiresAt <= Date.now()) {
    return { outcome: "expired" };
  }
  return { outcome: "ok", row };
}

function tokenErrorResponse(
  outcome: Exclude<TokenLookup["outcome"], "ok">,
): Response {
  switch (outcome) {
    case "expired":
      return jsonError("EXPIRED", "this credential link has expired", 404);
    case "used":
      return jsonError(
        "USED",
        "this credential link has already been used",
        404,
      );
    default:
      return jsonError("INVALID", "invalid credential link", 404);
  }
}

async function parseJsonBody(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const rawBody = await readLimitedBody(req, maxBytes);
  if (rawBody.status === "too_large") {
    return {
      ok: false,
      response: jsonError("PAYLOAD_TOO_LARGE", "request body too large", 413),
    };
  }
  if (rawBody.status === "unreadable") {
    return {
      ok: false,
      response: jsonError("BAD_REQUEST", "failed to read request body", 400),
    };
  }
  try {
    return { ok: true, body: JSON.parse(rawBody.text) };
  } catch {
    return {
      ok: false,
      response: jsonError("BAD_REQUEST", "invalid JSON body", 400),
    };
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const PeekRequestSchema = z.object({ token: z.string().min(20) });

export async function handleCredentialRequestPeek(
  req: Request,
): Promise<Response> {
  const parsed = await parseJsonBody(req, MAX_PEEK_BODY_BYTES);
  if (!parsed.ok) {
    return parsed.response;
  }
  const body = PeekRequestSchema.safeParse(parsed.body);
  if (!body.success) {
    return jsonError("BAD_REQUEST", "token is required", 400);
  }

  const lookup = lookupToken(body.data.token);
  if (lookup.outcome !== "ok") {
    return tokenErrorResponse(lookup.outcome);
  }

  return Response.json(
    {
      service: lookup.row.service,
      field: lookup.row.field,
      label: lookup.row.label,
      expiresAt: lookup.row.expiresAt,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const SubmitRequestSchema = z.object({
  token: z.string().min(20),
  value: z.string().min(1).max(32_768),
});

export async function handleCredentialRequestSubmit(
  req: Request,
): Promise<Response> {
  const parsed = await parseJsonBody(req, MAX_SUBMIT_BODY_BYTES);
  if (!parsed.ok) {
    return parsed.response;
  }
  const body = SubmitRequestSchema.safeParse(parsed.body);
  if (!body.success) {
    return jsonError("BAD_REQUEST", "token and value are required", 400);
  }

  const lookup = lookupToken(body.data.token);
  if (lookup.outcome !== "ok") {
    return tokenErrorResponse(lookup.outcome);
  }

  const store = new CredentialRequestStore();
  if (!store.claimForSubmission(lookup.row.id)) {
    // A racing submitter (or expiry) got there first.
    return tokenErrorResponse("used");
  }

  try {
    await ipcCallAssistant("credentials_set", {
      body: {
        service: lookup.row.service,
        field: lookup.row.field,
        value: body.data.value,
        label: lookup.row.label ?? undefined,
        // The credential policy captured at mint time is applied together
        // with the value, so an unredeemed link never mutates an existing
        // credential's metadata.
        ...parsePolicy(lookup.row.policyJson),
      },
    });
  } catch (err) {
    store.releaseClaim(lookup.row.id);
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      {
        requestId: lookup.row.id,
        service: lookup.row.service,
        field: lookup.row.field,
        error: message,
        handlerStatus: err instanceof IpcHandlerError ? err.statusCode : null,
      },
      "Credential-request submit failed to store via the daemon",
    );
    return jsonError(
      "STORE_FAILED",
      "the assistant could not store the credential — try again",
      502,
    );
  }

  store.completeRedemption(lookup.row.id);

  // Prompt-bound requests (purpose "prompt" + secretPromptId) additionally
  // resolve the daemon's pending secret prompt; that daemon-side fulfill
  // surface lands with the assistant link-fallback change — nothing mints
  // prompt-purpose rows until it exists.

  log.info(
    {
      requestId: lookup.row.id,
      service: lookup.row.service,
      field: lookup.row.field,
      purpose: lookup.row.purpose,
    },
    "Credential request fulfilled",
  );

  return Response.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// ---------------------------------------------------------------------------
// OpenAPI route metadata
// ---------------------------------------------------------------------------

const TokenErrorSchema = z.object({
  error: z.object({
    code: z.enum(["INVALID", "EXPIRED", "USED"]),
    message: z.string(),
  }),
});

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/v1/credential-requests/peek",
    method: "post",
    operationId: "credential_requests_peek",
    summary: "Validate a credential-request token without consuming it",
    description:
      "Returns the service/field/label the link collects. The token travels in the body so it never appears in URLs or access logs.",
    tags: ["credential-requests"],
    requestBody: PeekRequestSchema,
    responseBody: z.union([
      z.object({
        service: z.string(),
        field: z.string(),
        label: z.string().nullable(),
        expiresAt: z.number(),
      }),
      TokenErrorSchema,
    ]),
  },
  {
    path: "/v1/credential-requests/submit",
    method: "post",
    operationId: "credential_requests_submit",
    summary: "Consume a credential-request token and store the value",
    description:
      "Single-use: atomically claims the link, forwards the value to the assistant's credential store, and marks the link redeemed.",
    tags: ["credential-requests"],
    requestBody: SubmitRequestSchema,
    responseBody: z.union([z.object({ ok: z.boolean() }), TokenErrorSchema]),
  },
];

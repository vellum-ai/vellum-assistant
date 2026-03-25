/**
 * Route handlers for Twilio integration control-plane endpoints.
 *
 * GET    /v1/integrations/twilio/config                              — get current config status
 * POST   /v1/integrations/twilio/credentials                         — set Twilio credentials
 * DELETE /v1/integrations/twilio/credentials                         — clear Twilio credentials
 * GET    /v1/integrations/twilio/numbers                             — list account phone numbers
 * POST   /v1/integrations/twilio/numbers/provision                   — provision a new phone number
 * POST   /v1/integrations/twilio/numbers/assign                      — assign an existing number
 * POST   /v1/integrations/twilio/numbers/release                     — release a phone number
 */

import {
  getTwilioCredentials,
  hasTwilioCredentials,
  listIncomingPhoneNumbers,
  provisionPhoneNumber,
  releasePhoneNumber,
  searchAvailableNumbers,
} from "../../../calls/twilio-rest.js";
import { loadRawConfig, saveRawConfig } from "../../../config/loader.js";
import { syncTwilioWebhooks } from "../../../daemon/handlers/config-ingress.js";
import type { IngressConfig } from "../../../inbound/public-ingress-urls.js";
import { credentialKey } from "../../../security/credential-key.js";
import {
  deleteSecureKeyAsync,
  setSecureKeyAsync,
} from "../../../security/secure-keys.js";
import {
  deleteCredentialMetadata,
  upsertCredentialMetadata,
} from "../../../tools/credentials/metadata-store.js";
import type { RouteDefinition } from "../../http-router.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Helper to clear stale assistant phone number mappings. */
function pruneAssistantPhoneNumbers(
  twilio: Record<string, unknown>,
  keepNumber: string,
  mode: "keep" | "remove",
): void {
  const mappings = twilio.assistantPhoneNumbers as
    | Record<string, string>
    | undefined;
  if (mappings && typeof mappings === "object") {
    for (const [key, value] of Object.entries(mappings)) {
      const shouldDelete =
        mode === "keep" ? value !== keepNumber : value === keepNumber;
      if (shouldDelete) {
        delete mappings[key];
      }
    }
    if (Object.keys(mappings).length === 0) {
      delete twilio.assistantPhoneNumbers;
    }
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /v1/integrations/twilio/config
 */
export async function handleGetTwilioConfig(): Promise<Response> {
  const hasCredentials = await hasTwilioCredentials();
  const accountSid = hasCredentials
    ? (await getTwilioCredentials()).accountSid
    : undefined;
  const raw = loadRawConfig();
  const twilio = (raw?.twilio ?? {}) as Record<string, unknown>;
  const phoneNumber = (twilio.phoneNumber as string) ?? "";

  return Response.json({
    success: true,
    hasCredentials,
    accountSid: accountSid || undefined,
    phoneNumber: phoneNumber || undefined,
  });
}

/**
 * POST /v1/integrations/twilio/credentials
 *
 * Body: { accountSid: string, authToken: string }
 */
export async function handleSetTwilioCredentials(
  req: Request,
): Promise<Response> {
  let body: { accountSid?: string; authToken?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json(
      {
        success: false,
        hasCredentials: await hasTwilioCredentials(),
        error: "Invalid JSON in request body",
      },
      { status: 400 },
    );
  }

  if (!body.accountSid || !body.authToken) {
    return Response.json(
      {
        success: false,
        hasCredentials: await hasTwilioCredentials(),
        error: "accountSid and authToken are required",
      },
      { status: 400 },
    );
  }

  // Validate credentials against Twilio API
  const authHeader =
    "Basic " +
    Buffer.from(`${body.accountSid}:${body.authToken}`).toString("base64");
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${body.accountSid}.json`,
      { method: "GET", headers: { Authorization: authHeader } },
    );
    if (!res.ok) {
      const errBody = await res.text();
      return Response.json({
        success: false,
        hasCredentials: await hasTwilioCredentials(),
        error: `Twilio API validation failed (${res.status}): ${errBody}`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({
      success: false,
      hasCredentials: await hasTwilioCredentials(),
      error: `Failed to validate Twilio credentials: ${message}`,
    });
  }

  // Dual-write: secure key store is still read by the gateway for HMAC
  // validation (gateway/src/credential-reader.ts), while the assistant reads
  // from config via resolveAccountSid(). Both stores must stay in sync.
  const sidStored = await setSecureKeyAsync(
    credentialKey("twilio", "account_sid"),
    body.accountSid,
  );
  if (!sidStored) {
    return Response.json({
      success: false,
      hasCredentials: false,
      error: "Failed to store Account SID in secure storage",
    });
  }

  const tokenStored = await setSecureKeyAsync(
    credentialKey("twilio", "auth_token"),
    body.authToken,
  );
  if (!tokenStored) {
    await deleteSecureKeyAsync(credentialKey("twilio", "account_sid"));
    return Response.json({
      success: false,
      hasCredentials: false,
      error: "Failed to store Auth Token in secure storage",
    });
  }

  const raw = loadRawConfig();
  const twilio = (raw?.twilio ?? {}) as Record<string, unknown>;
  twilio.accountSid = body.accountSid;
  saveRawConfig({ ...raw, twilio });

  upsertCredentialMetadata("twilio", "account_sid", {
    injectionTemplates: [
      {
        hostPattern: "api.twilio.com",
        injectionType: "header" as const,
        headerName: "Authorization",
        valuePrefix: "Basic ",
        valueTransform: "base64" as const,
        composeWith: {
          service: "twilio",
          field: "auth_token",
          separator: ":",
        },
      },
      {
        hostPattern: "messaging.twilio.com",
        injectionType: "header" as const,
        headerName: "Authorization",
        valuePrefix: "Basic ",
        valueTransform: "base64" as const,
        composeWith: {
          service: "twilio",
          field: "auth_token",
          separator: ":",
        },
      },
    ],
  });
  upsertCredentialMetadata("twilio", "auth_token", {});

  return Response.json({ success: true, hasCredentials: true });
}

/**
 * DELETE /v1/integrations/twilio/credentials
 */
export async function handleClearTwilioCredentials(): Promise<Response> {
  const r1 = await deleteSecureKeyAsync(credentialKey("twilio", "account_sid"));
  const r2 = await deleteSecureKeyAsync(credentialKey("twilio", "auth_token"));

  if (r1 === "error" || r2 === "error") {
    return Response.json(
      {
        success: false,
        error: "Failed to delete Twilio credentials from secure storage",
      },
      { status: 500 },
    );
  }

  const raw = loadRawConfig();
  const twilio = (raw?.twilio ?? {}) as Record<string, unknown>;
  delete twilio.accountSid;
  saveRawConfig({ ...raw, twilio });

  deleteCredentialMetadata("twilio", "account_sid");
  deleteCredentialMetadata("twilio", "auth_token");

  return Response.json({ success: true, hasCredentials: false });
}

/**
 * GET /v1/integrations/twilio/numbers
 */
export async function handleListTwilioNumbers(): Promise<Response> {
  if (!(await hasTwilioCredentials())) {
    return Response.json({
      success: false,
      hasCredentials: false,
      error: "Twilio credentials not configured. Set credentials first.",
    });
  }

  const { accountSid, authToken } = await getTwilioCredentials();
  const numbers = await listIncomingPhoneNumbers(accountSid, authToken);

  return Response.json({ success: true, hasCredentials: true, numbers });
}

/**
 * POST /v1/integrations/twilio/numbers/provision
 *
 * Body: { country?: string, areaCode?: string }
 */
export async function handleProvisionTwilioNumber(
  req: Request,
): Promise<Response> {
  if (!(await hasTwilioCredentials())) {
    return Response.json({
      success: false,
      hasCredentials: false,
      error: "Twilio credentials not configured. Set credentials first.",
    });
  }

  let body: { country?: string; areaCode?: string };
  const provisionText = await req.text();
  if (!provisionText.trim()) {
    body = {};
  } else {
    try {
      body = JSON.parse(provisionText) as typeof body;
    } catch {
      return Response.json(
        {
          success: false,
          hasCredentials: await hasTwilioCredentials(),
          error: "Invalid JSON in request body",
        },
        { status: 400 },
      );
    }
  }
  const { accountSid, authToken } = await getTwilioCredentials();
  const country = body.country ?? "US";

  const available = await searchAvailableNumbers(
    accountSid,
    authToken,
    country,
    body.areaCode,
  );
  if (available.length === 0) {
    return Response.json({
      success: false,
      hasCredentials: true,
      error: `No available phone numbers found for country=${country}${body.areaCode ? ` areaCode=${body.areaCode}` : ""}`,
    });
  }

  const purchased = await provisionPhoneNumber(
    accountSid,
    authToken,
    available[0].phoneNumber,
  );

  const raw = loadRawConfig();
  const twilio = (raw?.twilio ?? {}) as Record<string, unknown>;
  twilio.phoneNumber = purchased.phoneNumber;
  pruneAssistantPhoneNumbers(twilio, purchased.phoneNumber, "keep");
  saveRawConfig({ ...raw, twilio });

  // Best-effort webhook configuration
  const webhookResult = await syncTwilioWebhooks(
    purchased.phoneNumber,
    accountSid,
    authToken,
    loadRawConfig() as IngressConfig,
  );

  return Response.json({
    success: true,
    hasCredentials: true,
    phoneNumber: purchased.phoneNumber,
    warning: webhookResult.warning,
  });
}

/**
 * POST /v1/integrations/twilio/numbers/assign
 *
 * Body: { phoneNumber: string }
 */
export async function handleAssignTwilioNumber(
  req: Request,
): Promise<Response> {
  let body: { phoneNumber?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json(
      {
        success: false,
        hasCredentials: await hasTwilioCredentials(),
        error: "Invalid JSON in request body",
      },
      { status: 400 },
    );
  }

  if (!body.phoneNumber) {
    return Response.json(
      {
        success: false,
        hasCredentials: await hasTwilioCredentials(),
        error: "phoneNumber is required",
      },
      { status: 400 },
    );
  }

  const raw = loadRawConfig();
  const twilio = (raw?.twilio ?? {}) as Record<string, unknown>;
  twilio.phoneNumber = body.phoneNumber;
  pruneAssistantPhoneNumbers(twilio, body.phoneNumber, "keep");
  saveRawConfig({ ...raw, twilio });

  // Best-effort webhook configuration when credentials are available
  let webhookWarning: string | undefined;
  if (await hasTwilioCredentials()) {
    const { accountSid: acctSid, authToken: acctToken } =
      await getTwilioCredentials();
    const webhookResult = await syncTwilioWebhooks(
      body.phoneNumber,
      acctSid,
      acctToken,
      loadRawConfig() as IngressConfig,
    );
    webhookWarning = webhookResult.warning;
  }

  return Response.json({
    success: true,
    hasCredentials: await hasTwilioCredentials(),
    phoneNumber: body.phoneNumber,
    warning: webhookWarning,
  });
}

/**
 * POST /v1/integrations/twilio/numbers/release
 *
 * Body: { phoneNumber?: string }
 */
export async function handleReleaseTwilioNumber(
  req: Request,
): Promise<Response> {
  if (!(await hasTwilioCredentials())) {
    return Response.json({
      success: false,
      hasCredentials: false,
      error: "Twilio credentials not configured. Set credentials first.",
    });
  }

  let body: { phoneNumber?: string };
  const releaseText = await req.text();
  if (!releaseText.trim()) {
    body = {};
  } else {
    try {
      body = JSON.parse(releaseText) as typeof body;
    } catch {
      return Response.json(
        {
          success: false,
          hasCredentials: await hasTwilioCredentials(),
          error: "Invalid JSON in request body",
        },
        { status: 400 },
      );
    }
  }
  const raw = loadRawConfig();
  const twilio = (raw?.twilio ?? {}) as Record<string, unknown>;
  const phoneNumber = body.phoneNumber || (twilio.phoneNumber as string) || "";

  if (!phoneNumber) {
    return Response.json({
      success: false,
      hasCredentials: true,
      error:
        "No phone number to release. Specify phoneNumber or ensure one is assigned.",
    });
  }

  const { accountSid, authToken } = await getTwilioCredentials();

  await releasePhoneNumber(accountSid, authToken, phoneNumber);

  if (twilio.phoneNumber === phoneNumber) {
    delete twilio.phoneNumber;
  }
  pruneAssistantPhoneNumbers(twilio, phoneNumber, "remove");
  saveRawConfig({ ...raw, twilio });

  return Response.json({
    success: true,
    hasCredentials: true,
    warning:
      "Phone number released from Twilio. Any associated toll-free verification context is lost.",
  });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function twilioRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "integrations/twilio/config",
      method: "GET",
      handler: async () => handleGetTwilioConfig(),
    },
    {
      endpoint: "integrations/twilio/credentials",
      method: "POST",
      handler: async ({ req }) => handleSetTwilioCredentials(req),
    },
    {
      endpoint: "integrations/twilio/credentials",
      method: "DELETE",
      handler: async () => handleClearTwilioCredentials(),
    },
    {
      endpoint: "integrations/twilio/numbers",
      method: "GET",
      handler: async () => handleListTwilioNumbers(),
    },
    {
      endpoint: "integrations/twilio/numbers/provision",
      method: "POST",
      handler: async ({ req }) => handleProvisionTwilioNumber(req),
    },
    {
      endpoint: "integrations/twilio/numbers/assign",
      method: "POST",
      handler: async ({ req }) => handleAssignTwilioNumber(req),
    },
    {
      endpoint: "integrations/twilio/numbers/release",
      method: "POST",
      handler: async ({ req }) => handleReleaseTwilioNumber(req),
    },
  ];
}

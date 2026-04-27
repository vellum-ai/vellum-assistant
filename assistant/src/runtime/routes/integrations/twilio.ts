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
import { BadRequestError, InternalError } from "../errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

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

async function handleGetTwilioConfig() {
  const hasCredentials = await hasTwilioCredentials();
  const accountSid = hasCredentials
    ? (await getTwilioCredentials()).accountSid
    : undefined;
  const raw = loadRawConfig();
  const twilio = (raw?.twilio ?? {}) as Record<string, unknown>;
  const phoneNumber = (twilio.phoneNumber as string) ?? "";

  return {
    success: true,
    hasCredentials,
    accountSid: accountSid || undefined,
    phoneNumber: phoneNumber || undefined,
  };
}

export async function handleSetTwilioCredentials({
  body = {},
}: RouteHandlerArgs) {
  const { accountSid, authToken } = body as {
    accountSid?: string;
    authToken?: string;
  };

  if (!accountSid || !authToken) {
    throw new BadRequestError("accountSid and authToken are required");
  }

  // Validate credentials against Twilio API
  const authHeader =
    "Basic " +
    Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`,
      { method: "GET", headers: { Authorization: authHeader } },
    );
    if (!res.ok) {
      const errBody = await res.text();
      throw new BadRequestError(
        `Twilio API validation failed (${res.status}): ${errBody}`,
      );
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new BadRequestError(
      `Failed to validate Twilio credentials: ${message}`,
    );
  }

  const sidStored = await setSecureKeyAsync(
    credentialKey("twilio", "account_sid"),
    accountSid,
  );
  if (!sidStored) {
    throw new InternalError(
      "Failed to store Account SID in secure storage",
    );
  }

  const tokenStored = await setSecureKeyAsync(
    credentialKey("twilio", "auth_token"),
    authToken,
  );
  if (!tokenStored) {
    await deleteSecureKeyAsync(credentialKey("twilio", "account_sid"));
    throw new InternalError(
      "Failed to store Auth Token in secure storage",
    );
  }

  const raw = loadRawConfig();
  const twilio = (raw?.twilio ?? {}) as Record<string, unknown>;
  twilio.accountSid = accountSid;
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

  return { success: true, hasCredentials: true };
}

export async function handleClearTwilioCredentials() {
  const r1 = await deleteSecureKeyAsync(credentialKey("twilio", "account_sid"));
  const r2 = await deleteSecureKeyAsync(credentialKey("twilio", "auth_token"));

  if (r1 === "error" || r2 === "error") {
    throw new InternalError(
      "Failed to delete Twilio credentials from secure storage",
    );
  }

  const raw = loadRawConfig();
  const twilio = (raw?.twilio ?? {}) as Record<string, unknown>;
  delete twilio.accountSid;
  saveRawConfig({ ...raw, twilio });

  deleteCredentialMetadata("twilio", "account_sid");
  deleteCredentialMetadata("twilio", "auth_token");

  return { success: true, hasCredentials: false };
}

async function handleListTwilioNumbers() {
  if (!(await hasTwilioCredentials())) {
    throw new BadRequestError(
      "Twilio credentials not configured. Set credentials first.",
    );
  }

  const { accountSid, authToken } = await getTwilioCredentials();
  const numbers = await listIncomingPhoneNumbers(accountSid, authToken);

  return { success: true, hasCredentials: true, numbers };
}

export async function handleProvisionTwilioNumber({
  body,
}: RouteHandlerArgs) {
  if (!(await hasTwilioCredentials())) {
    throw new BadRequestError(
      "Twilio credentials not configured. Set credentials first.",
    );
  }

  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const { country: rawCountry, areaCode } = body as {
    country?: string;
    areaCode?: string;
  };
  const { accountSid, authToken } = await getTwilioCredentials();
  const country = rawCountry ?? "US";

  const available = await searchAvailableNumbers(
    accountSid,
    authToken,
    country,
    areaCode,
  );
  if (available.length === 0) {
    throw new BadRequestError(
      `No available phone numbers found for country=${country}${areaCode ? ` areaCode=${areaCode}` : ""}`,
    );
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

  return {
    success: true,
    hasCredentials: true,
    phoneNumber: purchased.phoneNumber,
    warning: webhookResult.warning,
  };
}

export async function handleAssignTwilioNumber({
  body = {},
}: RouteHandlerArgs) {
  const { phoneNumber } = body as { phoneNumber?: string };

  if (!phoneNumber) {
    throw new BadRequestError("phoneNumber is required");
  }

  const raw = loadRawConfig();
  const twilio = (raw?.twilio ?? {}) as Record<string, unknown>;
  twilio.phoneNumber = phoneNumber;
  pruneAssistantPhoneNumbers(twilio, phoneNumber, "keep");
  saveRawConfig({ ...raw, twilio });

  // Best-effort webhook configuration when credentials are available
  let webhookWarning: string | undefined;
  if (await hasTwilioCredentials()) {
    const { accountSid: acctSid, authToken: acctToken } =
      await getTwilioCredentials();
    const webhookResult = await syncTwilioWebhooks(
      phoneNumber,
      acctSid,
      acctToken,
      loadRawConfig() as IngressConfig,
    );
    webhookWarning = webhookResult.warning;
  }

  return {
    success: true,
    hasCredentials: await hasTwilioCredentials(),
    phoneNumber,
    warning: webhookWarning,
  };
}

async function handleReleaseTwilioNumber({ body }: RouteHandlerArgs) {
  if (!(await hasTwilioCredentials())) {
    throw new BadRequestError(
      "Twilio credentials not configured. Set credentials first.",
    );
  }

  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const { phoneNumber: requestedNumber } = body as {
    phoneNumber?: string;
  };
  const raw = loadRawConfig();
  const twilio = (raw?.twilio ?? {}) as Record<string, unknown>;
  const phoneNumber =
    requestedNumber || (twilio.phoneNumber as string) || "";

  if (!phoneNumber) {
    throw new BadRequestError(
      "No phone number to release. Specify phoneNumber or ensure one is assigned.",
    );
  }

  const { accountSid, authToken } = await getTwilioCredentials();

  await releasePhoneNumber(accountSid, authToken, phoneNumber);

  if (twilio.phoneNumber === phoneNumber) {
    delete twilio.phoneNumber;
  }
  pruneAssistantPhoneNumbers(twilio, phoneNumber, "remove");
  saveRawConfig({ ...raw, twilio });

  return {
    success: true,
    hasCredentials: true,
    warning:
      "Phone number released from Twilio. Any associated toll-free verification context is lost.",
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "integrations_twilio_config_get",
    endpoint: "integrations/twilio/config",
    method: "GET",
    summary: "Get Twilio config",
    description: "Return current Twilio configuration status.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: () => handleGetTwilioConfig(),
  },
  {
    operationId: "integrations_twilio_credentials_post",
    endpoint: "integrations/twilio/credentials",
    method: "POST",
    summary: "Set Twilio credentials",
    description: "Validate and store Twilio account SID and auth token.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: handleSetTwilioCredentials,
  },
  {
    operationId: "integrations_twilio_credentials_delete",
    endpoint: "integrations/twilio/credentials",
    method: "DELETE",
    summary: "Clear Twilio credentials",
    description: "Remove stored Twilio credentials.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: () => handleClearTwilioCredentials(),
  },
  {
    operationId: "integrations_twilio_numbers_get",
    endpoint: "integrations/twilio/numbers",
    method: "GET",
    summary: "List Twilio numbers",
    description: "List phone numbers on the Twilio account.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: () => handleListTwilioNumbers(),
  },
  {
    operationId: "integrations_twilio_numbers_provision_post",
    endpoint: "integrations/twilio/numbers/provision",
    method: "POST",
    summary: "Provision Twilio number",
    description: "Search for and provision a new phone number.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: handleProvisionTwilioNumber,
  },
  {
    operationId: "integrations_twilio_numbers_assign_post",
    endpoint: "integrations/twilio/numbers/assign",
    method: "POST",
    summary: "Assign Twilio number",
    description: "Assign an existing phone number to this assistant.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: handleAssignTwilioNumber,
  },
  {
    operationId: "integrations_twilio_numbers_release_post",
    endpoint: "integrations/twilio/numbers/release",
    method: "POST",
    summary: "Release Twilio number",
    description: "Release a phone number back to Twilio.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: handleReleaseTwilioNumber,
  },
];

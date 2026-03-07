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
 * GET    /v1/integrations/twilio/sms/compliance                      — get SMS compliance status
 * POST   /v1/integrations/twilio/sms/compliance/tollfree             — submit toll-free verification
 * PATCH  /v1/integrations/twilio/sms/compliance/tollfree/:sid        — update toll-free verification
 * DELETE /v1/integrations/twilio/sms/compliance/tollfree/:sid        — delete toll-free verification
 * POST   /v1/integrations/twilio/sms/test                            — send a test SMS
 * POST   /v1/integrations/twilio/sms/doctor                          — run SMS diagnostics
 */

import { resolveTwilioPhoneNumber } from "../../calls/twilio-config.js";
import {
  deleteTollFreeVerification,
  fetchMessageStatus,
  getPhoneNumberSid,
  getTollFreeVerificationBySid,
  getTollFreeVerificationStatus,
  getTwilioCredentials,
  hasTwilioCredentials,
  listIncomingPhoneNumbers,
  provisionPhoneNumber,
  releasePhoneNumber,
  searchAvailableNumbers,
  submitTollFreeVerification,
  type TollFreeVerificationSubmitParams,
  updateTollFreeVerification,
} from "../../calls/twilio-rest.js";
import { getGatewayInternalBaseUrl } from "../../config/env.js";
import { loadRawConfig, saveRawConfig } from "../../config/loader.js";
import { getReadinessService } from "../../daemon/handlers/config-channels.js";
import { syncTwilioWebhooks } from "../../daemon/handlers/config-ingress.js";
import type { IngressConfig } from "../../inbound/public-ingress-urls.js";
import {
  deleteSecureKeyAsync,
  getSecureKey,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import {
  deleteCredentialMetadata,
  upsertCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import { mintDaemonDeliveryToken } from "../auth/token-service.js";
import type { RouteDefinition } from "../http-router.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** In-memory store for the last SMS send test result. Shared between sms_send_test and sms_doctor. */
let _lastTestResult:
  | {
      messageSid: string;
      to: string;
      initialStatus: string;
      finalStatus: string;
      errorCode?: string;
      errorMessage?: string;
      timestamp: number;
    }
  | undefined;

function mapTwilioErrorRemediation(
  errorCode: string | undefined,
): string | undefined {
  if (!errorCode) return undefined;
  const map: Record<string, string> = {
    "30003":
      "Unreachable destination. The handset may be off or out of service.",
    "30004": "Message blocked by carrier or recipient.",
    "30005": "Unknown destination phone number. Verify the number is valid.",
    "30006":
      "Landline or unreachable carrier. SMS cannot be delivered to this number.",
    "30007":
      "Message flagged as spam by carrier. Adjust content or register for A2P.",
    "30008": "Unknown error from the carrier network.",
    "21610":
      "Recipient has opted out (STOP). Cannot send until they opt back in.",
  };
  return map[errorCode];
}

const TWILIO_USE_CASE_ALIASES: Record<string, string> = {
  ACCOUNT_NOTIFICATION: "ACCOUNT_NOTIFICATIONS",
  DELIVERY_NOTIFICATION: "DELIVERY_NOTIFICATIONS",
  FRAUD_ALERT: "FRAUD_ALERT_MESSAGING",
  POLLING_AND_VOTING: "POLLING_AND_VOTING_NON_POLITICAL",
};

const TWILIO_VALID_USE_CASE_CATEGORIES = [
  "TWO_FACTOR_AUTHENTICATION",
  "ACCOUNT_NOTIFICATIONS",
  "CUSTOMER_CARE",
  "CHARITY_NONPROFIT",
  "DELIVERY_NOTIFICATIONS",
  "FRAUD_ALERT_MESSAGING",
  "EVENTS",
  "HIGHER_EDUCATION",
  "K12",
  "MARKETING",
  "POLLING_AND_VOTING_NON_POLITICAL",
  "POLITICAL_ELECTION_CAMPAIGNS",
  "PUBLIC_SERVICE_ANNOUNCEMENT",
  "SECURITY_ALERT",
] as const;

function normalizeUseCaseCategories(rawCategories: string[]): string[] {
  const normalized = rawCategories.map(
    (value) => TWILIO_USE_CASE_ALIASES[value] ?? value,
  );
  return Array.from(new Set(normalized));
}

/** Helper to clear stale assistant phone number mappings. */
function pruneAssistantPhoneNumbers(
  sms: Record<string, unknown>,
  keepNumber: string,
  mode: "keep" | "remove",
): void {
  const mappings = sms.assistantPhoneNumbers as
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
      delete sms.assistantPhoneNumbers;
    }
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /v1/integrations/twilio/config
 */
export function handleGetTwilioConfig(): Response {
  const hasCredentials = hasTwilioCredentials();
  const accountSid = hasCredentials
    ? getTwilioCredentials().accountSid
    : undefined;
  const raw = loadRawConfig();
  const sms = (raw?.sms ?? {}) as Record<string, unknown>;
  const phoneNumber = (sms.phoneNumber as string) ?? "";

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
  const body = (await req.json().catch(() => ({}))) as {
    accountSid?: string;
    authToken?: string;
  };

  if (!body.accountSid || !body.authToken) {
    return Response.json(
      {
        success: false,
        hasCredentials: hasTwilioCredentials(),
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
        hasCredentials: hasTwilioCredentials(),
        error: `Twilio API validation failed (${res.status}): ${errBody}`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({
      success: false,
      hasCredentials: hasTwilioCredentials(),
      error: `Failed to validate Twilio credentials: ${message}`,
    });
  }

  // Dual-write: secure key store is still read by the gateway for HMAC
  // validation (gateway/src/credential-reader.ts), while the assistant reads
  // from config via resolveAccountSid(). Both stores must stay in sync.
  const sidStored = await setSecureKeyAsync(
    "credential:twilio:account_sid",
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
    "credential:twilio:auth_token",
    body.authToken,
  );
  if (!tokenStored) {
    await deleteSecureKeyAsync("credential:twilio:account_sid");
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
  const r1 = await deleteSecureKeyAsync("credential:twilio:account_sid");
  const r2 = await deleteSecureKeyAsync("credential:twilio:auth_token");

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
  if (!hasTwilioCredentials()) {
    return Response.json({
      success: false,
      hasCredentials: false,
      error: "Twilio credentials not configured. Set credentials first.",
    });
  }

  const { accountSid, authToken } = getTwilioCredentials();
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
  if (!hasTwilioCredentials()) {
    return Response.json({
      success: false,
      hasCredentials: false,
      error: "Twilio credentials not configured. Set credentials first.",
    });
  }

  const body = (await req.json().catch(() => ({}))) as {
    country?: string;
    areaCode?: string;
  };
  const { accountSid, authToken } = getTwilioCredentials();
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

  const phoneStored = await setSecureKeyAsync(
    "credential:twilio:phone_number",
    purchased.phoneNumber,
  );
  if (!phoneStored) {
    return Response.json({
      success: false,
      hasCredentials: hasTwilioCredentials(),
      phoneNumber: purchased.phoneNumber,
      error: `Phone number ${purchased.phoneNumber} was purchased but could not be saved. Use assign to assign it manually.`,
    });
  }

  const raw = loadRawConfig();
  const sms = (raw?.sms ?? {}) as Record<string, unknown>;
  sms.phoneNumber = purchased.phoneNumber;
  pruneAssistantPhoneNumbers(sms, purchased.phoneNumber, "keep");
  saveRawConfig({ ...raw, sms });

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
  const body = (await req.json().catch(() => ({}))) as { phoneNumber?: string };

  if (!body.phoneNumber) {
    return Response.json(
      {
        success: false,
        hasCredentials: hasTwilioCredentials(),
        error: "phoneNumber is required",
      },
      { status: 400 },
    );
  }

  const phoneStored = await setSecureKeyAsync(
    "credential:twilio:phone_number",
    body.phoneNumber,
  );
  if (!phoneStored) {
    return Response.json({
      success: false,
      hasCredentials: hasTwilioCredentials(),
      error: "Failed to store phone number in secure storage",
    });
  }

  const raw = loadRawConfig();
  const sms = (raw?.sms ?? {}) as Record<string, unknown>;
  sms.phoneNumber = body.phoneNumber;
  pruneAssistantPhoneNumbers(sms, body.phoneNumber, "keep");
  saveRawConfig({ ...raw, sms });

  // Best-effort webhook configuration when credentials are available
  let webhookWarning: string | undefined;
  if (hasTwilioCredentials()) {
    const { accountSid: acctSid, authToken: acctToken } =
      getTwilioCredentials();
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
    hasCredentials: hasTwilioCredentials(),
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
  if (!hasTwilioCredentials()) {
    return Response.json({
      success: false,
      hasCredentials: false,
      error: "Twilio credentials not configured. Set credentials first.",
    });
  }

  const body = (await req.json().catch(() => ({}))) as { phoneNumber?: string };
  const raw = loadRawConfig();
  const sms = (raw?.sms ?? {}) as Record<string, unknown>;
  const phoneNumber = body.phoneNumber || (sms.phoneNumber as string) || "";

  if (!phoneNumber) {
    return Response.json({
      success: false,
      hasCredentials: true,
      error:
        "No phone number to release. Specify phoneNumber or ensure one is assigned.",
    });
  }

  const { accountSid, authToken } = getTwilioCredentials();

  await releasePhoneNumber(accountSid, authToken, phoneNumber);

  if (sms.phoneNumber === phoneNumber) {
    delete sms.phoneNumber;
  }
  pruneAssistantPhoneNumbers(sms, phoneNumber, "remove");
  saveRawConfig({ ...raw, sms });

  const storedPhone = getSecureKey("credential:twilio:phone_number");
  if (storedPhone === phoneNumber) {
    await deleteSecureKeyAsync("credential:twilio:phone_number");
  }

  return Response.json({
    success: true,
    hasCredentials: true,
    warning:
      "Phone number released from Twilio. Any associated toll-free verification context is lost.",
  });
}

/**
 * GET /v1/integrations/twilio/sms/compliance
 */
export async function handleGetSmsCompliance(): Promise<Response> {
  if (!hasTwilioCredentials()) {
    return Response.json({
      success: false,
      hasCredentials: false,
      error: "Twilio credentials not configured. Set credentials first.",
    });
  }

  const raw = loadRawConfig();
  const sms = (raw?.sms ?? {}) as Record<string, unknown>;
  const phoneNumber = (sms.phoneNumber as string) ?? "";

  if (!phoneNumber) {
    return Response.json({
      success: false,
      hasCredentials: true,
      error: "No phone number assigned. Assign a number first.",
    });
  }

  const { accountSid, authToken } = getTwilioCredentials();

  const tollFreePrefixes = [
    "+1800",
    "+1833",
    "+1844",
    "+1855",
    "+1866",
    "+1877",
    "+1888",
  ];
  const isTollFree = tollFreePrefixes.some((prefix) =>
    phoneNumber.startsWith(prefix),
  );
  const numberType = isTollFree ? "toll_free" : "local_10dlc";

  if (!isTollFree) {
    return Response.json({
      success: true,
      hasCredentials: true,
      phoneNumber,
      compliance: { numberType },
    });
  }

  const phoneSid = await getPhoneNumberSid(accountSid, authToken, phoneNumber);
  if (!phoneSid) {
    return Response.json({
      success: false,
      hasCredentials: true,
      phoneNumber,
      error: `Phone number ${phoneNumber} not found on Twilio account`,
    });
  }

  const verification = await getTollFreeVerificationStatus(
    accountSid,
    authToken,
    phoneSid,
  );

  return Response.json({
    success: true,
    hasCredentials: true,
    phoneNumber,
    compliance: {
      numberType,
      tollfreePhoneNumberSid: phoneSid,
      verificationSid: verification?.sid,
      verificationStatus: verification?.status,
      rejectionReason: verification?.rejectionReason,
      rejectionReasons: verification?.rejectionReasons,
      errorCode: verification?.errorCode,
      editAllowed: verification?.editAllowed,
      editExpiration: verification?.editExpiration,
    },
  });
}

/**
 * POST /v1/integrations/twilio/sms/compliance/tollfree
 *
 * Body: TollFreeVerificationSubmitParams
 */
export async function handleSubmitTollfreeVerification(
  req: Request,
): Promise<Response> {
  if (!hasTwilioCredentials()) {
    return Response.json({
      success: false,
      hasCredentials: false,
      error: "Twilio credentials not configured. Set credentials first.",
    });
  }

  const vp = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const requiredFields: Array<[string, unknown]> = [
    ["tollfreePhoneNumberSid", vp.tollfreePhoneNumberSid],
    ["businessName", vp.businessName],
    ["businessWebsite", vp.businessWebsite],
    ["notificationEmail", vp.notificationEmail],
    ["useCaseCategories", vp.useCaseCategories],
    ["useCaseSummary", vp.useCaseSummary],
    ["productionMessageSample", vp.productionMessageSample],
    ["optInImageUrls", vp.optInImageUrls],
    ["optInType", vp.optInType],
    ["messageVolume", vp.messageVolume],
  ];

  const missing = requiredFields
    .filter(
      ([, v]) => v == null || v === "" || (Array.isArray(v) && v.length === 0),
    )
    .map(([name]) => name);

  if (missing.length > 0) {
    return Response.json(
      {
        success: false,
        hasCredentials: true,
        error: `Missing required verification fields: ${missing.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const normalizedUseCaseCategories = normalizeUseCaseCategories(
    vp.useCaseCategories as string[],
  );
  const invalidCategories = normalizedUseCaseCategories.filter(
    (c) =>
      !TWILIO_VALID_USE_CASE_CATEGORIES.includes(
        c as (typeof TWILIO_VALID_USE_CASE_CATEGORIES)[number],
      ),
  );
  if (invalidCategories.length > 0) {
    return Response.json(
      {
        success: false,
        hasCredentials: true,
        error: `Invalid useCaseCategories: ${invalidCategories.join(", ")}. Valid values: ${TWILIO_VALID_USE_CASE_CATEGORIES.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const validOptInTypes = [
    "VERBAL",
    "WEB_FORM",
    "PAPER_FORM",
    "VIA_TEXT",
    "MOBILE_QR_CODE",
  ];
  if (!validOptInTypes.includes(vp.optInType as string)) {
    return Response.json(
      {
        success: false,
        hasCredentials: true,
        error: `Invalid optInType: ${vp.optInType}. Valid values: ${validOptInTypes.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const validMessageVolumes = [
    "10",
    "100",
    "1,000",
    "10,000",
    "100,000",
    "250,000",
    "500,000",
    "750,000",
    "1,000,000",
    "5,000,000",
    "10,000,000+",
  ];
  if (!validMessageVolumes.includes(vp.messageVolume as string)) {
    return Response.json(
      {
        success: false,
        hasCredentials: true,
        error: `Invalid messageVolume: ${vp.messageVolume}. Valid values: ${validMessageVolumes.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const { accountSid, authToken } = getTwilioCredentials();

  const submitParams: TollFreeVerificationSubmitParams = {
    tollfreePhoneNumberSid: vp.tollfreePhoneNumberSid as string,
    businessName: vp.businessName as string,
    businessWebsite: vp.businessWebsite as string,
    notificationEmail: vp.notificationEmail as string,
    useCaseCategories: normalizedUseCaseCategories,
    useCaseSummary: vp.useCaseSummary as string,
    productionMessageSample: vp.productionMessageSample as string,
    optInImageUrls: vp.optInImageUrls as string[],
    optInType: vp.optInType as string,
    messageVolume: vp.messageVolume as string,
    businessType: (vp.businessType as string) ?? "SOLE_PROPRIETOR",
    customerProfileSid: vp.customerProfileSid as string | undefined,
  };

  const verification = await submitTollFreeVerification(
    accountSid,
    authToken,
    submitParams,
  );

  return Response.json({
    success: true,
    hasCredentials: true,
    compliance: {
      numberType: "toll_free",
      verificationSid: verification.sid,
      verificationStatus: verification.status,
    },
  });
}

/**
 * PATCH /v1/integrations/twilio/sms/compliance/tollfree/:verificationSid
 *
 * Body: partial verification params to update
 */
export async function handleUpdateTollfreeVerification(
  req: Request,
  verificationSid: string,
): Promise<Response> {
  if (!hasTwilioCredentials()) {
    return Response.json({
      success: false,
      hasCredentials: false,
      error: "Twilio credentials not configured. Set credentials first.",
    });
  }

  const { accountSid, authToken } = getTwilioCredentials();

  const currentVerification = await getTollFreeVerificationBySid(
    accountSid,
    authToken,
    verificationSid,
  );
  if (!currentVerification) {
    return Response.json({
      success: false,
      hasCredentials: true,
      error: `Verification ${verificationSid} was not found on this Twilio account.`,
    });
  }

  if (currentVerification.status === "TWILIO_REJECTED") {
    const expirationMillis = currentVerification.editExpiration
      ? Date.parse(currentVerification.editExpiration)
      : Number.NaN;
    const editExpired =
      Number.isFinite(expirationMillis) && Date.now() > expirationMillis;
    if (currentVerification.editAllowed === false || editExpired) {
      const detail = editExpired
        ? `edit_expiration=${currentVerification.editExpiration}`
        : "edit_allowed=false";
      return Response.json({
        success: false,
        hasCredentials: true,
        error: `Verification ${verificationSid} cannot be updated (${detail}). Delete and resubmit instead.`,
        compliance: {
          numberType: "toll_free",
          verificationSid: currentVerification.sid,
          verificationStatus: currentVerification.status,
          editAllowed: currentVerification.editAllowed,
          editExpiration: currentVerification.editExpiration,
        },
      });
    }
  }

  const updateParams = {
    ...((await req.json().catch(() => ({}))) as Record<string, unknown>),
  };
  if (updateParams.useCaseCategories) {
    updateParams.useCaseCategories = normalizeUseCaseCategories(
      updateParams.useCaseCategories as string[],
    );
  }

  const verification = await updateTollFreeVerification(
    accountSid,
    authToken,
    verificationSid,
    updateParams,
  );

  return Response.json({
    success: true,
    hasCredentials: true,
    compliance: {
      numberType: "toll_free",
      verificationSid: verification.sid,
      verificationStatus: verification.status,
      editAllowed: verification.editAllowed,
      editExpiration: verification.editExpiration,
    },
  });
}

/**
 * DELETE /v1/integrations/twilio/sms/compliance/tollfree/:verificationSid
 */
export async function handleDeleteTollfreeVerification(
  verificationSid: string,
): Promise<Response> {
  if (!hasTwilioCredentials()) {
    return Response.json({
      success: false,
      hasCredentials: false,
      error: "Twilio credentials not configured. Set credentials first.",
    });
  }

  const { accountSid, authToken } = getTwilioCredentials();

  await deleteTollFreeVerification(accountSid, authToken, verificationSid);

  return Response.json({
    success: true,
    hasCredentials: true,
    warning:
      "Toll-free verification deleted. Re-submitting may reset your position in the review queue.",
  });
}

/**
 * POST /v1/integrations/twilio/sms/test
 *
 * Body: { phoneNumber: string, text?: string }
 */
export async function handleSmsSendTest(req: Request): Promise<Response> {
  if (!hasTwilioCredentials()) {
    return Response.json({
      success: false,
      hasCredentials: false,
      error: "Twilio credentials not configured. Set credentials first.",
    });
  }

  const body = (await req.json().catch(() => ({}))) as {
    phoneNumber?: string;
    text?: string;
  };
  const to = body.phoneNumber;
  if (!to) {
    return Response.json(
      {
        success: false,
        hasCredentials: true,
        error: "phoneNumber is required for SMS send test.",
      },
      { status: 400 },
    );
  }

  const from = resolveTwilioPhoneNumber();
  if (!from) {
    return Response.json({
      success: false,
      hasCredentials: true,
      error:
        "No phone number assigned. Run the twilio-setup skill to assign a number.",
    });
  }

  const { accountSid, authToken } = getTwilioCredentials();
  const text = body.text || "Test SMS from your Vellum assistant";

  // Send via gateway's /deliver/sms endpoint
  const bearerToken = mintDaemonDeliveryToken();
  const gatewayUrl = getGatewayInternalBaseUrl();

  const sendResp = await fetch(`${gatewayUrl}/deliver/sms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify({ to, text }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!sendResp.ok) {
    const errBody = await sendResp.text().catch(() => "<unreadable>");
    return Response.json({
      success: false,
      hasCredentials: true,
      error: `SMS send failed (${sendResp.status}): ${errBody}`,
    });
  }

  const sendData = (await sendResp.json().catch(() => ({}))) as {
    messageSid?: string;
    status?: string;
  };
  const messageSid = sendData.messageSid || "";
  const initialStatus = sendData.status || "unknown";

  // Poll Twilio for final status (up to 3 times, 2s apart)
  let finalStatus = initialStatus;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;

  if (messageSid) {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const pollResult = await fetchMessageStatus(
          accountSid,
          authToken,
          messageSid,
        );
        finalStatus = pollResult.status;
        errorCode = pollResult.errorCode;
        errorMessage = pollResult.errorMessage;
        if (["delivered", "undelivered", "failed"].includes(finalStatus)) break;
      } catch {
        break;
      }
    }
  }

  const testResult = {
    messageSid,
    to,
    initialStatus,
    finalStatus,
    ...(errorCode ? { errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };

  _lastTestResult = { ...testResult, timestamp: Date.now() };

  return Response.json({
    success: true,
    hasCredentials: true,
    testResult,
  });
}

/**
 * POST /v1/integrations/twilio/sms/doctor
 */
export async function handleSmsDoctor(): Promise<Response> {
  const hasCredentials = hasTwilioCredentials();

  // 1. Channel readiness check
  let readinessReady = false;
  const readinessIssues: string[] = [];
  try {
    const readinessService = getReadinessService();
    const snapshots = await readinessService.getReadiness("sms", false);
    const snapshot = snapshots[0];
    if (snapshot) {
      readinessReady = snapshot.ready;
      for (const r of snapshot.reasons) {
        readinessIssues.push(r.text);
      }
    } else {
      readinessIssues.push("No readiness snapshot returned for SMS channel");
    }
  } catch (err) {
    readinessIssues.push(
      `Readiness check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. Compliance status
  let complianceStatus = "unknown";
  let complianceDetail: string | undefined;
  let complianceRemediation: string | undefined;
  if (hasCredentials) {
    try {
      const phoneNumber = resolveTwilioPhoneNumber();
      if (phoneNumber) {
        const { accountSid, authToken } = getTwilioCredentials();
        const isTollFree =
          phoneNumber.startsWith("+1") &&
          ["800", "888", "877", "866", "855", "844", "833"].some((p) =>
            phoneNumber.startsWith(`+1${p}`),
          );
        if (isTollFree) {
          try {
            const phoneSid = await getPhoneNumberSid(
              accountSid,
              authToken,
              phoneNumber,
            );
            if (!phoneSid) {
              complianceStatus = "check_failed";
              complianceDetail = `Assigned number ${phoneNumber} was not found on the Twilio account`;
              complianceRemediation =
                "Reassign the number in twilio-setup or update credentials to the matching account.";
            } else {
              const verification = await getTollFreeVerificationStatus(
                accountSid,
                authToken,
                phoneSid,
              );
              if (verification) {
                const status = verification.status;
                complianceStatus = status;
                complianceDetail = `Toll-free verification: ${status}`;
                if (status === "TWILIO_APPROVED") {
                  complianceRemediation = undefined;
                } else if (
                  status === "PENDING_REVIEW" ||
                  status === "IN_REVIEW"
                ) {
                  complianceRemediation =
                    "Toll-free verification is pending. Messaging may have limited throughput until approved.";
                } else if (status === "TWILIO_REJECTED") {
                  if (verification.editAllowed) {
                    complianceRemediation = verification.editExpiration
                      ? `Toll-free verification was rejected but can still be edited until ${verification.editExpiration}. Update and resubmit it.`
                      : "Toll-free verification was rejected but can still be edited. Update and resubmit it.";
                  } else {
                    complianceRemediation =
                      "Toll-free verification was rejected and is no longer editable. Delete and resubmit it.";
                  }
                } else {
                  complianceRemediation =
                    "Submit a toll-free verification to enable full messaging throughput.";
                }
              } else {
                complianceStatus = "unverified";
                complianceDetail = "Toll-free number without verification";
                complianceRemediation =
                  "Submit a toll-free verification request to avoid filtering.";
              }
            }
          } catch {
            complianceStatus = "check_failed";
            complianceDetail =
              "Could not retrieve toll-free verification status";
          }
        } else {
          complianceStatus = "local_10dlc";
          complianceDetail =
            "Local/10DLC number — carrier registration handled externally";
        }
      } else {
        complianceStatus = "no_number";
        complianceDetail = "No phone number assigned";
        complianceRemediation =
          "Assign a phone number via the twilio-setup skill.";
      }
    } catch {
      complianceStatus = "check_failed";
      complianceDetail = "Could not determine compliance status";
    }
  } else {
    complianceStatus = "no_credentials";
    complianceDetail = "Twilio credentials are not configured";
    complianceRemediation =
      "Set Twilio credentials via the twilio-setup skill.";
  }

  // 3. Last send test result
  let lastSend:
    | { status: string; errorCode?: string; remediation?: string }
    | undefined;
  if (_lastTestResult) {
    lastSend = {
      status: _lastTestResult.finalStatus,
      ...(_lastTestResult.errorCode
        ? { errorCode: _lastTestResult.errorCode }
        : {}),
      ...(_lastTestResult.errorCode
        ? { remediation: mapTwilioErrorRemediation(_lastTestResult.errorCode) }
        : {}),
    };
  }

  // 4. Overall status
  const actionItems: string[] = [];
  let overallStatus: "healthy" | "degraded" | "broken" = "healthy";

  if (!hasCredentials) {
    overallStatus = "broken";
    actionItems.push("Configure Twilio credentials.");
  }
  if (!readinessReady) {
    overallStatus = "broken";
    for (const issue of readinessIssues) actionItems.push(issue);
  }
  if (
    complianceStatus === "unverified" ||
    complianceStatus === "PENDING_REVIEW" ||
    complianceStatus === "IN_REVIEW"
  ) {
    if (overallStatus === "healthy") overallStatus = "degraded";
    if (complianceRemediation) actionItems.push(complianceRemediation);
  }
  if (
    complianceStatus === "TWILIO_REJECTED" ||
    complianceStatus === "no_number"
  ) {
    overallStatus = "broken";
    if (complianceRemediation) actionItems.push(complianceRemediation);
  }
  if (
    _lastTestResult &&
    ["failed", "undelivered"].includes(_lastTestResult.finalStatus)
  ) {
    if (overallStatus === "healthy") overallStatus = "degraded";
    const remediation = mapTwilioErrorRemediation(_lastTestResult.errorCode);
    actionItems.push(
      remediation ||
        `Last test SMS ${_lastTestResult.finalStatus}. Check Twilio logs for details.`,
    );
  }

  return Response.json({
    success: true,
    hasCredentials,
    diagnostics: {
      readiness: { ready: readinessReady, issues: readinessIssues },
      compliance: {
        status: complianceStatus,
        ...(complianceDetail ? { detail: complianceDetail } : {}),
        ...(complianceRemediation
          ? { remediation: complianceRemediation }
          : {}),
      },
      ...(lastSend ? { lastSend } : {}),
      overallStatus,
      actionItems,
    },
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
      handler: () => handleGetTwilioConfig(),
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
    {
      endpoint: "integrations/twilio/sms/compliance",
      method: "GET",
      handler: async () => handleGetSmsCompliance(),
    },
    {
      endpoint: "integrations/twilio/sms/compliance/tollfree",
      method: "POST",
      handler: async ({ req }) => handleSubmitTollfreeVerification(req),
    },
    {
      endpoint: "integrations/twilio/sms/compliance/tollfree/:sid",
      method: "PATCH",
      policyKey: "integrations/twilio/sms/compliance/tollfree",
      handler: async ({ req, params }) =>
        handleUpdateTollfreeVerification(req, params.sid),
    },
    {
      endpoint: "integrations/twilio/sms/compliance/tollfree/:sid",
      method: "DELETE",
      policyKey: "integrations/twilio/sms/compliance/tollfree",
      handler: async ({ params }) =>
        handleDeleteTollfreeVerification(params.sid),
    },
    {
      endpoint: "integrations/twilio/sms/test",
      method: "POST",
      handler: async ({ req }) => handleSmsSendTest(req),
    },
    {
      endpoint: "integrations/twilio/sms/doctor",
      method: "POST",
      handler: async () => handleSmsDoctor(),
    },
  ];
}

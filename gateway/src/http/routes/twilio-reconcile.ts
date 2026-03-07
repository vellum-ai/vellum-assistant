import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyToken } from "../../auth/token-service.js";
import type { GatewayConfig } from "../../config.js";
import { readConfigFileDefaults } from "../../config-file-mappings.js";
import {
  getRootDir,
  readCredential,
  readTwilioCredentials,
} from "../../credential-reader.js";
import { getLogger } from "../../logger.js";

const log = getLogger("twilio-reconcile");

function normalizeIngressPublicBaseUrl(value: string): string | undefined {
  const normalized = value.trim().replace(/\/+$/, "");
  return normalized || undefined;
}

async function readLatestTwilioConfigState(): Promise<
  Pick<
    GatewayConfig,
    "twilioAccountSid" | "twilioAuthToken" | "twilioPhoneNumber"
  >
> {
  const twilioCreds = await readTwilioCredentials();

  let configFileData: Record<string, unknown> = {};
  try {
    const cfgPath = join(getRootDir(), "workspace", "config.json");
    const raw = readFileSync(cfgPath, "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      configFileData = data as Record<string, unknown>;
    }
  } catch {
    // The workspace config may not exist yet; fall back to env + credentials.
  }

  const configDefaults = readConfigFileDefaults(configFileData);

  const twilioAuthToken =
    process.env.TWILIO_AUTH_TOKEN || twilioCreds?.authToken || undefined;

  let twilioAccountSid =
    process.env.TWILIO_ACCOUNT_SID || twilioCreds?.accountSid || undefined;
  if (!twilioAccountSid) {
    twilioAccountSid = configDefaults.twilioAccountSid as string | undefined;
  }

  let twilioPhoneNumber =
    process.env.TWILIO_PHONE_NUMBER ||
    (configDefaults.twilioPhoneNumber as string | undefined);
  if (!twilioPhoneNumber) {
    twilioPhoneNumber =
      (await readCredential("credential:twilio:phone_number")) || undefined;
  }

  return {
    twilioAccountSid,
    twilioAuthToken,
    twilioPhoneNumber,
  };
}

/**
 * Internal endpoint that refreshes Twilio validation state after ingress or
 * credential changes so webhook validation can use the latest config without
 * waiting for file watchers or a gateway restart.
 */
export function createTwilioReconcileHandler(config: GatewayConfig) {
  // Serialize reconcile operations so concurrent requests cannot interleave
  // a stale ingress URL or credential snapshot over a later refresh.
  let reconcileChain: Promise<void> = Promise.resolve();

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const token = authHeader.slice(7);
    const authResult = verifyToken(token, "vellum-daemon");
    if (!authResult.ok) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: { ingressPublicBaseUrl?: string } = {};
    try {
      const text = await req.text();
      if (text) {
        body = JSON.parse(text) as typeof body;
      }
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const ingressPublicBaseUrlProvided =
      typeof body.ingressPublicBaseUrl === "string";
    const normalizedIngressPublicBaseUrl = ingressPublicBaseUrlProvided
      ? normalizeIngressPublicBaseUrl(body.ingressPublicBaseUrl)
      : undefined;

    const result = new Promise<Response>((resolve) => {
      reconcileChain = reconcileChain
        .then(async () => {
          try {
            const latestState = await readLatestTwilioConfigState();
            const nextIngressPublicBaseUrl = ingressPublicBaseUrlProvided
              ? normalizedIngressPublicBaseUrl
              : config.ingressPublicBaseUrl;

            config.ingressPublicBaseUrl = nextIngressPublicBaseUrl;
            config.twilioAccountSid = latestState.twilioAccountSid;
            config.twilioAuthToken = latestState.twilioAuthToken;
            config.twilioPhoneNumber = latestState.twilioPhoneNumber;

            log.info(
              {
                ingressPublicBaseUrl: config.ingressPublicBaseUrl,
                twilioAccountSidConfigured: !!config.twilioAccountSid,
                twilioAuthTokenConfigured: !!config.twilioAuthToken,
                twilioPhoneNumberConfigured: !!config.twilioPhoneNumber,
              },
              "Twilio validation state reconciled via internal endpoint",
            );
            resolve(Response.json({ ok: true }));
          } catch (err) {
            log.error(
              { err },
              "Failed to reconcile Twilio validation state via internal endpoint",
            );
            resolve(
              Response.json(
                { error: "Reconciliation failed" },
                { status: 502 },
              ),
            );
          }
        })
        .catch(() => {});
    });

    return result;
  };
}

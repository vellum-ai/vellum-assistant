/**
 * `POST /v1/shared/invites/redeem`: exchanges a `vellum-shared` invite link
 * token for a trusted-contact principal and a device-bound token pair.
 *
 * Unauthenticated: the link token in the body is the credential. Failed
 * attempts are counted per client IP, and a client over the limit is refused
 * before its body is read. Hidden with a 404 while `vellum-trusted-contacts`
 * is off.
 */

import { z } from "zod";

import { AuthRateLimiter } from "../../auth-rate-limiter.js";
import { isFeatureFlagEnabled } from "../../feature-flag-resolver.js";
import { getLogger } from "../../logger.js";
import { redeemSharedInvite } from "../../verification/shared-invite-redemption.js";
import { errorResponse } from "../loopback-guard.js";
import { readJsonObjectBody } from "../route-helpers.js";

const log = getLogger("shared-invite-redeem");

const TRUSTED_CONTACTS_FLAG = "vellum-trusted-contacts";
const MAX_REDEEM_BODY_BYTES = 1024;
const RETRY_AFTER_SECONDS = 60;

const RedeemRequestSchema = z.object({
  code: z
    .string({ error: "code is required" })
    .trim()
    .min(1, "code is required"),
  deviceId: z
    .string({ error: "deviceId is required" })
    .trim()
    .min(1, "deviceId is required"),
});

let failureLimiter = new AuthRateLimiter();

/** Test helper: clear the per-IP failure counts. */
export function resetSharedInviteRedeemRateLimiterForTests(): void {
  failureLimiter = new AuthRateLimiter();
}

/** Responses carry credentials or describe them, so none is cacheable. */
function noStore(res: Response): Response {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function rateLimitedResponse(): Response {
  return noStore(
    Response.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "too many failed invite redemptions",
        },
      },
      {
        status: 429,
        headers: { "Retry-After": String(RETRY_AFTER_SECONDS) },
      },
    ),
  );
}

function failedAttempt(clientIp: string, res: Response): Response {
  failureLimiter.recordFailure(clientIp);
  return noStore(res);
}

export async function handleSharedInviteRedeem(
  req: Request,
  clientIp: string,
): Promise<Response> {
  if (!isFeatureFlagEnabled(TRUSTED_CONTACTS_FLAG)) {
    return noStore(errorResponse("NOT_FOUND", "not found", 404));
  }
  if (failureLimiter.isBlocked(clientIp)) {
    return rateLimitedResponse();
  }

  const body = await readJsonObjectBody(req, MAX_REDEEM_BODY_BYTES);
  if (body instanceof Response) {
    return failedAttempt(clientIp, body);
  }
  const parsed = RedeemRequestSchema.safeParse(body);
  if (!parsed.success) {
    return failedAttempt(
      clientIp,
      errorResponse(
        "BAD_REQUEST",
        parsed.error.issues[0]?.message ?? "invalid request body",
        400,
      ),
    );
  }

  let result: ReturnType<typeof redeemSharedInvite>;
  try {
    result = redeemSharedInvite({
      token: parsed.data.code,
      deviceId: parsed.data.deviceId,
    });
  } catch (err) {
    log.error({ err }, "Shared invite redemption failed");
    return noStore(
      errorResponse("INTERNAL_ERROR", "invite redemption failed", 500),
    );
  }

  switch (result.status) {
    case "invalid":
      return failedAttempt(
        clientIp,
        errorResponse(
          "INVALID_OR_EXPIRED_INVITE",
          "invalid or expired invite",
          401,
        ),
      );
    case "contact_unavailable":
      return noStore(
        errorResponse(
          "INVITE_NOT_REDEEMABLE",
          "invite can no longer be redeemed",
          409,
        ),
      );
    case "redeemed":
      return noStore(
        Response.json({
          principalId: result.principalId,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: result.accessTokenExpiresAt,
        }),
      );
  }
}

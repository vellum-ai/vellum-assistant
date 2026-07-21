/**
 * Route handler for `POST /v1/pair/qr-code`.
 *
 * Loopback-only mint of a single-use QR pairing code on the host machine. The
 * CLI renders the returned code as a QR; a phone that scans it presents the
 * code to the public `POST /v1/pair/qr-exchange` route for device-bound tokens.
 *
 * Possession of the code is the proof of physical presence at the host, so
 * minting is restricted to loopback callers exactly like `/v1/pair` (peer IP,
 * Host header, and the unspoofable edge-forwarded marker are all enforced by
 * {@link enforceLoopbackOnly}). The self-hosted nginx edge additionally 404s
 * this path so it is never reachable over the tunnel. A browser `Origin` is
 * rejected too: a local WebView must not be able to mint a code and read it
 * back through the gateway's WebView CORS allowance.
 */

import { getLogger } from "../../logger.js";
import {
  checkQrPairingCodeCapacity,
  createQrPairingCode,
} from "../../remote-web/qr-pairing-code-store.js";
import { enforceLoopbackOnly, rejectBrowserOrigin } from "../loopback-guard.js";

const log = getLogger("pair-qr-code");

export async function handleMintQrPairingCode(
  req: Request,
  clientIp: string,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  const guardError = enforceLoopbackOnly(req, clientIp, "pair-qr-code");
  if (guardError) return guardError;

  const originError = rejectBrowserOrigin(req, clientIp, "pair-qr-code");
  if (originError) return originError;

  const capacityLimited = checkQrPairingCodeCapacity();
  if (capacityLimited) {
    return Response.json(
      {
        error: {
          code: "QR_PAIRING_CODE_CAPACITY_EXCEEDED",
          message: "too many active QR pairing codes",
        },
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(capacityLimited.retryAfterSeconds),
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const created = createQrPairingCode();
  log.info(
    { expiresAt: created.expiresAt },
    "Minted QR pairing code via loopback",
  );

  return Response.json(created, { headers: { "Cache-Control": "no-store" } });
}

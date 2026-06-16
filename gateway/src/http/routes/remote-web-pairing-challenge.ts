import { createRemoteWebPairingChallenge } from "../../remote-web/pairing-challenge-store.js";
import { enforceLoopbackOnly } from "../loopback-guard.js";

function parsePublicBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.host) return null;
    const pathPrefix = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathPrefix}`;
  } catch {
    return null;
  }
}

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

export async function handleCreateRemoteWebPairingChallenge(
  req: Request,
  clientIp: string,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  const guardError = enforceLoopbackOnly(
    req,
    clientIp,
    "remote-web-pairing-challenge",
  );
  if (guardError) return guardError;

  let publicBaseUrl: string | null = null;
  try {
    const body = (await req.json()) as { publicBaseUrl?: unknown };
    publicBaseUrl = parsePublicBaseUrl(body.publicBaseUrl);
  } catch {
    return jsonError("BAD_REQUEST", "invalid JSON body", 400);
  }

  if (!publicBaseUrl) {
    return jsonError("BAD_REQUEST", "publicBaseUrl is required", 400);
  }

  const challenge = createRemoteWebPairingChallenge(publicBaseUrl);

  return Response.json(challenge, {
    headers: { "Cache-Control": "no-store" },
  });
}

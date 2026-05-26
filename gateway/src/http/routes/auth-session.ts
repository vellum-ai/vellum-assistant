import type { Server } from "bun";

import { ensureVellumGuardianBinding } from "../../auth/guardian-bootstrap.js";
import {
  mintSessionCookie,
  clearSessionCookie,
} from "../../auth/session-cookie.js";
import { getLogger } from "../../logger.js";
import { isLoopbackPeer } from "../../util/is-loopback-address.js";

const log = getLogger("auth-session");

const WEB_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export async function handleCreateSession(
  req: Request,
  server: Server<unknown> | undefined,
): Promise<Response> {
  if (!server || !isLoopbackPeer(server, req)) {
    log.warn("Session create rejected: not a loopback peer");
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const origin = req.headers.get("origin");
  if (!origin || !WEB_ORIGIN_RE.test(origin)) {
    log.warn({ origin }, "Session create rejected: missing or invalid Origin");
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const guardianPrincipalId = await ensureVellumGuardianBinding();

  const cookie = mintSessionCookie({ guardianPrincipalId });
  log.info("Session cookie minted for local auto-pair");

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookie,
    },
  });
}

export async function handleDeleteSession(
  _req: Request,
): Promise<Response> {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearSessionCookie(),
    },
  });
}

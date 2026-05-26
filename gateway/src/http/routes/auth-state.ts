import { validateSessionCookie } from "../../auth/session-cookie.js";

export async function handleAuthState(req: Request): Promise<Response> {
  const result = validateSessionCookie(req);

  if (result.ok) {
    return Response.json({ authenticated: true, mode: "session" });
  }

  return Response.json({ authenticated: false, mode: "none" });
}

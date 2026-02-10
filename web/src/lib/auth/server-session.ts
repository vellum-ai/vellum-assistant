import { Assistant, getDb } from "@/lib/db";
import { auth } from "@/lib/auth/better-auth";

export interface RequestUser {
  id: string | null;
  username: string | null;
  email: string | null;
  isAdmin: boolean;
}

function normalizeEmail(email: string | null): string | null {
  if (!email) {
    return null;
  }
  return email.trim().toLowerCase();
}

export async function getRequestUser(request: Request): Promise<RequestUser> {
  let id: string | null = null;
  let username: string | null = null;
  let email: string | null = null;
  let emailVerified = false;

  try {
    const sessionResult = await (auth.api as unknown as {
      getSession?: (args: { headers: Headers }) => Promise<unknown>;
    }).getSession?.({
      headers: request.headers,
    });

    const session = (sessionResult as { user?: { id?: string; username?: string; name?: string; email?: string; emailVerified?: boolean } })?.user
      ? (sessionResult as { user?: { id?: string; username?: string; name?: string; email?: string; emailVerified?: boolean } })
      : ((sessionResult as { data?: { user?: { id?: string; username?: string; name?: string; email?: string; emailVerified?: boolean } } })?.data ??
        null);

    id = session?.user?.id ?? null;
    username = session?.user?.username ?? null;
    email = session?.user?.email ?? null;
    emailVerified = Boolean(session?.user?.emailVerified);
  } catch {
    // Fall through to unauthorized checks below.
  }

  const normalizedEmail = normalizeEmail(email);
  return {
    id,
    username,
    email: normalizedEmail,
    // Admin privileges require authenticated + verified internal email.
    isAdmin: Boolean(normalizedEmail?.endsWith("@vellum.ai") && emailVerified),
  };
}

export async function requireAssistantOwner(
  request: Request,
  assistantId: string
): Promise<{ assistant: Assistant; user: RequestUser }> {
  const sql = getDb();
  const result = await sql`SELECT * FROM assistants WHERE id = ${assistantId}`;
  if (result.length === 0) {
    throw new Error("NOT_FOUND");
  }

  const assistant = result[0] as Assistant;
  const user = await getRequestUser(request);
  if (!user.id && !user.username && !user.isAdmin) {
    throw new Error("UNAUTHORIZED");
  }

  const createdBy = assistant.createdBy?.trim() || null;
  if (user.isAdmin) {
    return { assistant, user };
  }

  if (
    createdBy &&
    ((user.username && createdBy === user.username) ||
      (user.id && createdBy === user.id))
  ) {
    return { assistant, user };
  }

  throw new Error("FORBIDDEN");
}

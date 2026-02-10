import { Assistant, getDb } from "@/lib/db";
import { auth } from "@/lib/auth/better-auth";

export interface RequestUser {
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
  let username: string | null = null;
  let email: string | null = null;

  try {
    const sessionResult = await (auth.api as unknown as {
      getSession?: (args: { headers: Headers }) => Promise<unknown>;
    }).getSession?.({
      headers: request.headers,
    });

    const session = (sessionResult as { user?: { username?: string; name?: string; email?: string } })?.user
      ? (sessionResult as { user?: { username?: string; name?: string; email?: string } })
      : ((sessionResult as { data?: { user?: { username?: string; name?: string; email?: string } } })?.data ??
        null);

    username = session?.user?.username ?? session?.user?.name ?? null;
    email = session?.user?.email ?? null;
  } catch {
    // Fallback to headers below.
  }

  if (!username) {
    username = request.headers.get("x-username");
  }
  if (!email) {
    email = request.headers.get("x-email");
  }

  const normalizedEmail = normalizeEmail(email);
  return {
    username,
    email: normalizedEmail,
    isAdmin: normalizedEmail?.endsWith("@vellum.ai") ?? false,
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
  if (!user.username && !user.isAdmin) {
    throw new Error("UNAUTHORIZED");
  }

  const createdBy = assistant.createdBy?.trim() || null;
  if (user.isAdmin) {
    return { assistant, user };
  }

  if (createdBy && user.username && createdBy === user.username) {
    return { assistant, user };
  }

  // Pre-launch assistants can have null created_by.
  if (!createdBy && user.username) {
    return { assistant, user };
  }

  throw new Error("FORBIDDEN");
}

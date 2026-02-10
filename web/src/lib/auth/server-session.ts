import { Assistant, getDb } from "@/lib/db";
import { auth } from "@/lib/auth/better-auth";

export interface RequestUser {
  id: string | null;
  username: string | null;
  name: string | null;
  email: string | null;
  isAdmin: boolean;
}

function normalizeEmail(email: string | null): string | null {
  if (!email) {
    return null;
  }
  return email.trim().toLowerCase();
}

type UserIdLookupRow = {
  id: string;
};

async function resolveOwnerUserId(
  sql: ReturnType<typeof getDb>,
  createdBy: string
): Promise<string | null> {
  // Canonical namespace: treat created_by as user.id when possible.
  const byId = await sql<UserIdLookupRow[]>`
    SELECT id
    FROM "user"
    WHERE id = ${createdBy}
    LIMIT 1
  `;
  if (byId.length > 0 && typeof byId[0]?.id === "string") {
    return byId[0].id;
  }

  // Backward compatibility for assistants that still store username values.
  const byUsername = await sql<UserIdLookupRow[]>`
    SELECT id
    FROM "user"
    WHERE username = ${createdBy}
    LIMIT 1
  `;
  if (byUsername.length > 0 && typeof byUsername[0]?.id === "string") {
    return byUsername[0].id;
  }

  return null;
}

export async function getRequestUser(request: Request): Promise<RequestUser> {
  let id: string | null = null;
  let username: string | null = null;
  let name: string | null = null;
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
    name = session?.user?.name?.trim() || null;
    email = session?.user?.email ?? null;
    emailVerified = Boolean(session?.user?.emailVerified);
  } catch {
    // Fall through to unauthorized checks below.
  }

  const normalizedEmail = normalizeEmail(email);
  return {
    id,
    username,
    name,
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

  const assistant = result[0] as Assistant & { created_by?: string | null };
  const user = await getRequestUser(request);
  if (!user.id && !user.isAdmin) {
    throw new Error("UNAUTHORIZED");
  }

  const createdBy =
    assistant.created_by?.trim() || assistant.createdBy?.trim() || null;
  if (user.isAdmin) {
    return { assistant, user };
  }

  if (createdBy && user.id) {
    const ownerUserId = await resolveOwnerUserId(sql, createdBy);
    if (ownerUserId === user.id) {
      if (createdBy !== user.id) {
        await sql`
          UPDATE assistants
          SET created_by = ${user.id}
          WHERE id = ${assistantId}
            AND created_by = ${createdBy}
        `;
      }
      return { assistant, user };
    }
  }

  // Backward compatibility: legacy assistants may store display name in created_by.
  // Only allow this path when the display name uniquely maps to the current user id.
  if (createdBy && user.name && user.id && createdBy === user.name) {
    const nameMatches = await sql`
      SELECT id
      FROM "user"
      WHERE name = ${createdBy}
      LIMIT 2
    `;
    if (nameMatches.length === 1 && nameMatches[0]?.id === user.id) {
      if (createdBy !== user.id) {
        await sql`
          UPDATE assistants
          SET created_by = ${user.id}
          WHERE id = ${assistantId}
            AND created_by = ${createdBy}
        `;
      }
      return { assistant, user };
    }
  }

  throw new Error("FORBIDDEN");
}

import { NextResponse } from "next/server";

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
  // Authenticate before lookup to avoid leaking resource existence.
  const user = await getRequestUser(request);
  if (!user.id) {
    throw new Error("UNAUTHORIZED");
  }

  const sql = getDb();
  const result = await sql`SELECT * FROM assistants WHERE id = ${assistantId}`;
  if (result.length === 0) {
    throw new Error("NOT_FOUND");
  }

  const assistant = result[0] as Assistant & { created_by?: string | null };

  const createdBy =
    assistant.created_by?.trim() || assistant.createdBy?.trim() || null;

  if (createdBy === user.id) {
    return { assistant, user };
  }

  // Backward compatibility: created_by may store a username.
  if (createdBy && user.username && createdBy === user.username) {
    // Migrate to canonical user ID for future lookups.
    await sql`UPDATE assistants SET created_by = ${user.id} WHERE id = ${assistantId}`;
    const updatedResult = await sql`SELECT * FROM assistants WHERE id = ${assistantId}`;
    return { assistant: updatedResult[0] as Assistant, user };
  }

  throw new Error("FORBIDDEN");
}

export function toAuthErrorResponse(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : "Unknown error";
  if (message === "NOT_FOUND") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (message === "UNAUTHORIZED") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (message === "FORBIDDEN") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (message === "Contact not found") {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

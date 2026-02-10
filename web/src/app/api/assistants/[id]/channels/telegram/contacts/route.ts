import { NextRequest, NextResponse } from "next/server";

import { requireAssistantOwner } from "@/lib/auth/server-session";
import { AssistantChannelContactStatus } from "@/lib/channels/db";
import { listTelegramContacts } from "@/lib/channels/service";

interface RouteParams {
  params: Promise<{ id: string }>;
}

function isValidStatus(value: string | null): value is AssistantChannelContactStatus {
  return value === "pending" || value === "approved" || value === "blocked";
}

function toErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  if (message === "NOT_FOUND") {
    return NextResponse.json({ error: "Assistant not found" }, { status: 404 });
  }
  if (message === "UNAUTHORIZED") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (message === "FORBIDDEN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({ error: "Failed to list contacts" }, { status: 500 });
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;
    await requireAssistantOwner(request, assistantId);

    const statusParam = request.nextUrl.searchParams.get("status");
    const status = isValidStatus(statusParam) ? statusParam : undefined;

    const contacts = await listTelegramContacts({
      assistantId,
      status,
    });
    return NextResponse.json({ contacts });
  } catch (error) {
    console.error("Error listing Telegram contacts:", error);
    return toErrorResponse(error);
  }
}

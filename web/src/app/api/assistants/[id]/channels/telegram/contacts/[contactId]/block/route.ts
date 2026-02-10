import { NextRequest, NextResponse } from "next/server";

import { requireAssistantOwner } from "@/lib/auth/server-session";
import { blockTelegramContact } from "@/lib/channels/service";

interface RouteParams {
  params: Promise<{ id: string; contactId: string }>;
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
  if (message === "Contact not found") {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId, contactId } = await params;
    await requireAssistantOwner(request, assistantId);

    const contact = await blockTelegramContact(assistantId, contactId);
    return NextResponse.json({ success: true, contact });
  } catch (error) {
    console.error("Error blocking Telegram contact:", error);
    return toErrorResponse(error);
  }
}

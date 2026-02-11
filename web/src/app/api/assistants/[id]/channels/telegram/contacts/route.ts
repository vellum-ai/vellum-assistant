import { NextRequest, NextResponse } from "next/server";

import { requireAssistantOwner, toAuthErrorResponse } from "@/lib/auth/server-session";
import { AssistantChannelContactStatus } from "@/lib/channels/db";
import { listTelegramContacts } from "@/lib/channels/service";

interface RouteParams {
  params: Promise<{ id: string }>;
}

function isValidStatus(value: string | null): value is AssistantChannelContactStatus {
  return value === "pending" || value === "approved" || value === "blocked";
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
    return toAuthErrorResponse(error);
  }
}

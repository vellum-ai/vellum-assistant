import { NextRequest, NextResponse } from "next/server";

import { requireAssistantOwner, toAuthErrorResponse } from "@/lib/auth/server-session";
import { blockTelegramContact } from "@/lib/channels/service";

interface RouteParams {
  params: Promise<{ id: string; contactId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId, contactId } = await params;
    await requireAssistantOwner(request, assistantId);

    const contact = await blockTelegramContact(assistantId, contactId);
    return NextResponse.json({ success: true, contact });
  } catch (error) {
    console.error("Error blocking Telegram contact:", error);
    return toAuthErrorResponse(error);
  }
}

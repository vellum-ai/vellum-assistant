import { NextRequest, NextResponse } from "next/server";

import { requireAssistantOwner, toAuthErrorResponse } from "@/lib/auth/server-session";
import {
  approveTelegramContact,
  notifyApprovedTelegramContact,
} from "@/lib/channels/service";

interface RouteParams {
  params: Promise<{ id: string; contactId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId, contactId } = await params;
    await requireAssistantOwner(request, assistantId);

    const contact = await approveTelegramContact(assistantId, contactId);
    let notificationSent = true;
    try {
      await notifyApprovedTelegramContact({ assistantId, contactId });
    } catch (error) {
      notificationSent = false;
      console.warn("Approved contact, but failed to send Telegram notification:", error);
    }

    return NextResponse.json({ success: true, contact, notificationSent });
  } catch (error) {
    console.error("Error approving Telegram contact:", error);
    return toAuthErrorResponse(error);
  }
}

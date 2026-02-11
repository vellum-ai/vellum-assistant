import { NextRequest, NextResponse } from "next/server";

import { requireAssistantOwner, toAuthErrorResponse } from "@/lib/auth/server-session";
import {
  connectTelegramChannel,
  disconnectTelegramChannel,
  getTelegramChannelAccountForAssistant,
} from "@/lib/channels/service";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;
    await requireAssistantOwner(request, assistantId);

    const account = await getTelegramChannelAccountForAssistant(assistantId);
    if (!account) {
      return NextResponse.json({ configured: false, channel: null });
    }

    const config = { ...((account.config || {}) as Record<string, unknown>) };
    delete config.botToken;
    delete config.webhookSecret;
    return NextResponse.json({
      configured: true,
      channel: {
        id: account.id,
        enabled: account.enabled,
        status: account.status,
        lastError: account.last_error,
        config,
      },
    });
  } catch (error) {
    console.error("Error getting Telegram channel:", error);
    return toAuthErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;
    await requireAssistantOwner(request, assistantId);

    const body = (await request.json()) as { botToken?: string; enabled?: boolean };
    const botToken =
      typeof body.botToken === "string" ? body.botToken.trim() : "";
    if (!botToken) {
      return NextResponse.json(
        { error: "botToken is required" },
        { status: 400 }
      );
    }

    const channel = await connectTelegramChannel({
      assistantId,
      botToken,
      enabled: body.enabled ?? true,
    });

    return NextResponse.json({ channel });
  } catch (error) {
    console.error("Error connecting Telegram channel:", error);
    return toAuthErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;
    await requireAssistantOwner(request, assistantId);

    const result = await disconnectTelegramChannel(assistantId);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Error disconnecting Telegram channel:", error);
    return toAuthErrorResponse(error);
  }
}

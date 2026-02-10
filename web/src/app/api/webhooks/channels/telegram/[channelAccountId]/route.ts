import { NextRequest, NextResponse } from "next/server";

import { handleTelegramWebhook } from "@/lib/channels/service";

interface RouteParams {
  params: Promise<{ channelAccountId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { channelAccountId } = await params;
    const payload = (await request.json()) as Record<string, unknown>;

    const result = await handleTelegramWebhook({
      channelAccountId,
      headers: request.headers,
      payload,
    });

    // Telegram expects a fast 200 response for accepted webhooks.
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("Error processing Telegram channel webhook:", error);
    return NextResponse.json(
      { ok: false, error: "Failed to process Telegram webhook" },
      { status: 500 }
    );
  }
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { channelAccountId } = await params;
  return NextResponse.json({
    ok: true,
    channel: "telegram",
    channelAccountId,
  });
}

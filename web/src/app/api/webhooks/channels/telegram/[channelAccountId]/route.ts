import { NextRequest, NextResponse } from "next/server";

import { handleTelegramWebhook } from "@/lib/channels/service";

interface RouteParams {
  params: Promise<{ channelAccountId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { channelAccountId } = await params;
    const payload = (await request.json()) as Record<string, unknown>;
    const headers = new Headers(request.headers);

    // Telegram retries aggressively when webhook responses are slow, so we
    // acknowledge first and complete assistant work asynchronously.
    void handleTelegramWebhook({
      channelAccountId,
      headers,
      payload,
    }).catch((error) => {
      console.error("Async Telegram channel webhook processing failed:", error);
    });

    return NextResponse.json({ ok: true, accepted: true });
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

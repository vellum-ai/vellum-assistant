import { after, NextRequest, NextResponse } from "next/server";

import { handleTelegramWebhook } from "@/lib/channels/service";

export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ channelAccountId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { channelAccountId } = await params;
  const payload = (await request.json()) as Record<string, unknown>;

  after(async () => {
    try {
      await handleTelegramWebhook({
        channelAccountId,
        headers: request.headers,
        payload,
      });
    } catch (error) {
      console.error("[TG webhook] Error processing Telegram channel webhook:", error);
    }
  });

  return NextResponse.json({ ok: true });
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { channelAccountId } = await params;
  return NextResponse.json({
    ok: true,
    channel: "telegram",
    channelAccountId,
  });
}

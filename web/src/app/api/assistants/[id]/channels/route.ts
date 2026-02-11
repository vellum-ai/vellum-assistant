import { NextRequest, NextResponse } from "next/server";

import { requireAssistantOwner, toAuthErrorResponse } from "@/lib/auth/server-session";
import { listAssistantChannels } from "@/lib/channels/service";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;
    await requireAssistantOwner(request, assistantId);

    const channels = await listAssistantChannels(assistantId);
    return NextResponse.json({ channels });
  } catch (error) {
    console.error("Error listing assistant channels:", error);
    return toAuthErrorResponse(error);
  }
}

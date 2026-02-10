import { NextRequest, NextResponse } from "next/server";

import { requireAssistantOwner } from "@/lib/auth/server-session";
import { listAssistantChannels } from "@/lib/channels/service";

interface RouteParams {
  params: Promise<{ id: string }>;
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
  return NextResponse.json({ error: "Failed to list channels" }, { status: 500 });
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;
    await requireAssistantOwner(request, assistantId);

    const channels = await listAssistantChannels(assistantId);
    return NextResponse.json({ channels });
  } catch (error) {
    console.error("Error listing assistant channels:", error);
    return toErrorResponse(error);
  }
}

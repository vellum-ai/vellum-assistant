import { NextRequest, NextResponse } from "next/server";

import { getAssistantById } from "@/lib/db";
import { createRuntimeClient, RuntimeClientError } from "@/lib/runtime/client";
import { resolveRuntime } from "@/lib/runtime/resolver";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;

    const assistant = await getAssistantById(assistantId);
    if (!assistant) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const { baseUrl } = resolveRuntime(assistantId);
    const client = createRuntimeClient(baseUrl, assistantId);
    const conversationKey = assistantId;

    const messageId = request.nextUrl.searchParams.get("messageId") ?? undefined;

    const result = await client.getSuggestion({ conversationKey, messageId });

    return NextResponse.json(result);
  } catch (error: unknown) {
    if (error instanceof RuntimeClientError) {
      return NextResponse.json(
        { suggestion: null, messageId: null, source: "none" as const },
        { status: error.status },
      );
    }
    console.error("Error fetching suggestion:", error);
    return NextResponse.json(
      { suggestion: null, messageId: null, source: "none" as const },
      { status: 500 },
    );
  }
}

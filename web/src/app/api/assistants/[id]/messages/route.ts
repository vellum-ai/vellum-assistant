import { NextRequest, NextResponse } from "next/server";

import { requireAssistantOwner, toAuthErrorResponse } from "@/lib/auth/server-session";
import { createRuntimeClient, RuntimeClientError } from "@/lib/runtime/client";
import { resolveRuntime } from "@/lib/runtime/resolver";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

interface PostMessageBody {
  content?: unknown;
  attachment_ids?: unknown;
  conversationKey?: unknown;
}

function normalizeAttachmentIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return [...new Set(ids)];
}

function getRuntimeClient(assistantId: string) {
  const { baseUrl } = resolveRuntime(assistantId);
  return createRuntimeClient(baseUrl, assistantId);
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;
    await requireAssistantOwner(request, assistantId);

    const client = getRuntimeClient(assistantId);
    const conversationKey = assistantId;

    const result = await client.listMessages({ conversationKey });

    return NextResponse.json({
      messages: result.messages,
      errors: [],
    });
  } catch (error: unknown) {
    console.error("Error fetching messages:", error);
    if (error instanceof RuntimeClientError) {
      return NextResponse.json(
        { error: "Failed to fetch messages" },
        { status: error.httpStatus },
      );
    }
    if (error instanceof Error && ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN"].includes(error.message)) {
      return toAuthErrorResponse(error);
    }
    return NextResponse.json(
      { error: "Failed to fetch messages" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;
    await requireAssistantOwner(request, assistantId);

    const body = await request.json() as PostMessageBody;
    const content = typeof body.content === "string" ? body.content : "";
    const trimmedContent = content.trim();
    const attachmentIds = normalizeAttachmentIds(body.attachment_ids);

    if (!trimmedContent && attachmentIds.length === 0) {
      return NextResponse.json(
        { error: "Either content or attachment_ids is required" },
        { status: 400 },
      );
    }

    const client = getRuntimeClient(assistantId);
    const conversationKey = assistantId;

    const result = await client.sendMessage({
      conversationKey,
      content,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
    });

    return NextResponse.json({
      accepted: result.accepted,
      messageId: result.messageId,
      ...(result.runId ? { runId: result.runId } : {}),
      ...(result.assistantMessage ? { assistantMessage: result.assistantMessage } : {}),
    });
  } catch (error: unknown) {
    console.error("Error sending message:", error);
    if (error instanceof RuntimeClientError) {
      return NextResponse.json(
        { error: "Failed to send message" },
        { status: error.httpStatus },
      );
    }
    if (error instanceof Error && ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN"].includes(error.message)) {
      return toAuthErrorResponse(error);
    }
    return NextResponse.json(
      { error: "Failed to send message" },
      { status: 500 },
    );
  }
}

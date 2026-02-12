import { NextRequest, NextResponse } from "next/server";

import { getAssistantById } from "@/lib/db";
import { createRuntimeClient, RuntimeClientError } from "@/lib/runtime/client";
import { resolveRuntime } from "@/lib/runtime/resolver";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

function getRuntimeClient(assistantId: string) {
  const { baseUrl } = resolveRuntime(assistantId);
  return createRuntimeClient(baseUrl, assistantId);
}

function normalizeAttachmentIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return [...new Set(ids)];
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;

    const assistant = await getAssistantById(assistantId);
    if (!assistant) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const body = await request.json() as {
      content?: unknown;
      attachment_ids?: unknown;
    };

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

    const result = await client.createRun({
      conversationKey,
      content,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error: unknown) {
    console.error("Error creating run:", error);
    const status = error instanceof RuntimeClientError ? error.httpStatus : 500;
    return NextResponse.json(
      { error: "Failed to create run" },
      { status },
    );
  }
}

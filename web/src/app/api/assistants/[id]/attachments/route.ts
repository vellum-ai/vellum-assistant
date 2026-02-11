import { NextRequest, NextResponse } from "next/server";

import { createRuntimeClient, RuntimeClientError } from "@/lib/runtime/client";
import { resolveRuntime } from "@/lib/runtime/resolver";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface UploadResponseAttachment {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  kind: string;
  created_at: null;
}

function getFilesFromFormData(formData: FormData): File[] {
  const directFiles = formData.getAll("files").filter((value): value is File => value instanceof File);
  if (directFiles.length > 0) {
    return directFiles;
  }
  return [...formData.values()].filter((value): value is File => value instanceof File);
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

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;

    const formData = await request.formData();
    const files = getFilesFromFormData(formData);
    if (files.length === 0) {
      return NextResponse.json(
        { error: "At least one file is required under the 'files' field" },
        { status: 400 },
      );
    }

    const client = getRuntimeClient(assistantId);
    const createdAttachments: UploadResponseAttachment[] = [];

    for (const file of files) {
      const arrayBuffer = await file.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      const result = await client.uploadAttachment({
        filename: file.name || "attachment",
        mimeType: file.type || "application/octet-stream",
        data: base64,
      });
      createdAttachments.push({
        id: result.id,
        original_filename: result.original_filename,
        mime_type: result.mime_type,
        size_bytes: result.size_bytes,
        kind: result.kind,
        created_at: null,
      });
    }

    return NextResponse.json({ attachments: createdAttachments }, { status: 201 });
  } catch (error) {
    console.error("Error uploading attachments:", error);
    const status = error instanceof RuntimeClientError ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to upload attachments" },
      { status },
    );
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;

    const body = await request.json().catch(() => ({})) as { attachment_ids?: unknown };
    const attachmentIds = normalizeAttachmentIds(body.attachment_ids);
    if (attachmentIds.length === 0) {
      return NextResponse.json(
        { error: "attachment_ids must contain at least one attachment id" },
        { status: 400 },
      );
    }

    const client = getRuntimeClient(assistantId);

    for (const attachmentId of attachmentIds) {
      await client.deleteAttachment({ attachmentId });
    }

    return NextResponse.json({ deleted_ids: attachmentIds });
  } catch (error) {
    console.error("Error deleting attachments:", error);
    const status = error instanceof RuntimeClientError ? error.status : 500;
    return NextResponse.json(
      { error: "Failed to delete attachments" },
      { status },
    );
  }
}

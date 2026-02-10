import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import {
  createChatAttachment,
  getDb,
} from "@/lib/db";
import {
  processAttachmentUpload,
  sanitizeFilename,
} from "@/lib/attachments";
import { getStorage } from "@/lib/storage";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const ATTACHMENTS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || "vellum-ai-prod-vellum-assistant";
const ATTACHMENTS_PREFIX = "vellum-assistant/chat-attachments";

interface UploadResponseAttachment {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  kind: string;
  created_at: Date | null;
}

function getFilesFromFormData(formData: FormData): File[] {
  const directFiles = formData.getAll("files").filter((value): value is File => value instanceof File);
  if (directFiles.length > 0) {
    return directFiles;
  }
  return [...formData.values()].filter((value): value is File => value instanceof File);
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;
    const sql = getDb();
    const assistants = await sql`SELECT * FROM assistants WHERE id = ${assistantId}`;
    if (assistants.length === 0) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const formData = await request.formData();
    const files = getFilesFromFormData(formData);
    if (files.length === 0) {
      return NextResponse.json(
        { error: "At least one file is required under the 'files' field" },
        { status: 400 },
      );
    }

    const storage = getStorage();
    const bucket = storage.bucket(ATTACHMENTS_BUCKET_NAME);
    const createdAttachments: UploadResponseAttachment[] = [];

    for (const file of files) {
      const fileName = file.name || "attachment";
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const processed = await processAttachmentUpload(fileName, file.type, buffer);
      const attachmentId = randomUUID();
      const storageKey = `${ATTACHMENTS_PREFIX}/${assistantId}/${attachmentId}/${sanitizeFilename(fileName)}`;

      await bucket.file(storageKey).save(buffer, {
        contentType: processed.mimeType,
        metadata: {
          assistantId,
          attachmentId,
          originalFilename: processed.fileName,
          mimeType: processed.mimeType,
          sizeBytes: String(processed.sizeBytes),
          sha256: processed.sha256,
          kind: processed.kind,
          createdAt: new Date().toISOString(),
        },
      });

      const saved = await createChatAttachment({
        id: attachmentId,
        assistantId,
        originalFilename: processed.fileName,
        mimeType: processed.mimeType,
        sizeBytes: processed.sizeBytes,
        storageKey,
        sha256: processed.sha256,
        kind: processed.kind,
        extractedText: processed.extractedText,
      });

      createdAttachments.push({
        id: saved.id,
        original_filename: saved.originalFilename,
        mime_type: saved.mimeType,
        size_bytes: saved.sizeBytes,
        kind: saved.kind,
        created_at: saved.createdAt ?? null,
      });
    }

    return NextResponse.json({ attachments: createdAttachments }, { status: 201 });
  } catch (error) {
    console.error("Error uploading attachments:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to upload attachments" },
      { status: 500 },
    );
  }
}

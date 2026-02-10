import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import {
  db,
  getDb,
} from "@/lib/db";
import { chatAttachmentsTable } from "@/lib/schema";
import {
  processAttachmentUpload,
  sanitizeFilename,
  type ProcessedAttachment,
} from "@/lib/attachments";
import { getStorage, type StorageBucket } from "@/lib/storage";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const ATTACHMENTS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || "vellum-ai-prod-vellum-assistant";
const ATTACHMENTS_PREFIX = "vellum-assistant/chat-attachments";
const MAX_FILES_PER_UPLOAD = 10;
const MAX_TOTAL_BUFFERED_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BUFFERED_MIB = MAX_TOTAL_BUFFERED_BYTES / (1024 * 1024);

interface UploadResponseAttachment {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  kind: string;
  created_at: Date | null;
}

interface PreparedUpload {
  attachmentId: string;
  fileName: string;
  processed: ProcessedAttachment;
  buffer: Buffer;
  storageKey: string;
}

class AttachmentValidationError extends Error {}

function getFilesFromFormData(formData: FormData): File[] {
  const directFiles = formData.getAll("files").filter((value): value is File => value instanceof File);
  if (directFiles.length > 0) {
    return directFiles;
  }
  return [...formData.values()].filter((value): value is File => value instanceof File);
}

async function cleanupUploadedObjects(bucket: StorageBucket, storageKeys: string[]): Promise<void> {
  await Promise.all(
    storageKeys.map(async (storageKey) => {
      try {
        await bucket.file(storageKey).delete();
      } catch (error) {
        console.warn(`[attachments] Failed to clean up object "${storageKey}"`, error);
      }
    }),
  );
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
    if (files.length > MAX_FILES_PER_UPLOAD) {
      return NextResponse.json(
        { error: `A maximum of ${MAX_FILES_PER_UPLOAD} files can be uploaded at once` },
        { status: 400 },
      );
    }

    const declaredTotalBytes = files.reduce((total, file) => total + file.size, 0);
    if (declaredTotalBytes > MAX_TOTAL_BUFFERED_BYTES) {
      return NextResponse.json(
        { error: `Total attachment size cannot exceed ${MAX_TOTAL_BUFFERED_MIB}MB per request` },
        { status: 400 },
      );
    }

    const storage = getStorage();
    const bucket = storage.bucket(ATTACHMENTS_BUCKET_NAME);
    const preparedUploads: PreparedUpload[] = [];
    let totalBufferedBytes = 0;

    for (const file of files) {
      const fileName = file.name || "attachment";
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      totalBufferedBytes += buffer.byteLength;
      if (totalBufferedBytes > MAX_TOTAL_BUFFERED_BYTES) {
        throw new AttachmentValidationError(
          `Total attachment size cannot exceed ${MAX_TOTAL_BUFFERED_MIB}MB per request`,
        );
      }

      const attachmentId = randomUUID();
      let processed: ProcessedAttachment;
      try {
        processed = await processAttachmentUpload(fileName, file.type, buffer);
      } catch (error) {
        throw new AttachmentValidationError(
          error instanceof Error ? error.message : `Failed to process "${fileName}"`,
        );
      }
      const storageKey = `${ATTACHMENTS_PREFIX}/${assistantId}/${attachmentId}/${sanitizeFilename(fileName)}`;

      preparedUploads.push({
        attachmentId,
        fileName,
        processed,
        buffer,
        storageKey,
      });
    }

    const uploadedStorageKeys: string[] = [];
    try {
      for (const upload of preparedUploads) {
        await bucket.file(upload.storageKey).save(upload.buffer, {
          contentType: upload.processed.mimeType,
          metadata: {
            assistantId,
            attachmentId: upload.attachmentId,
            originalFilename: upload.processed.fileName,
            mimeType: upload.processed.mimeType,
            sizeBytes: String(upload.processed.sizeBytes),
            sha256: upload.processed.sha256,
            kind: upload.processed.kind,
            createdAt: new Date().toISOString(),
          },
        });
        uploadedStorageKeys.push(upload.storageKey);
      }
    } catch (error) {
      await cleanupUploadedObjects(bucket, uploadedStorageKeys);
      throw error;
    }

    let createdAttachments: UploadResponseAttachment[] = [];
    try {
      const insertedRows = await db
        .insert(chatAttachmentsTable)
        .values(preparedUploads.map((upload) => ({
          id: upload.attachmentId,
          assistantId,
          originalFilename: upload.processed.fileName,
          mimeType: upload.processed.mimeType,
          sizeBytes: upload.processed.sizeBytes,
          storageKey: upload.storageKey,
          sha256: upload.processed.sha256,
          kind: upload.processed.kind,
          extractedText: upload.processed.extractedText,
        })))
        .returning();

      const insertedById = new Map(insertedRows.map((row) => [row.id, row]));
      createdAttachments = preparedUploads.map((upload) => {
        const saved = insertedById.get(upload.attachmentId);
        if (!saved) {
          throw new Error(`Missing inserted attachment row for ${upload.attachmentId}`);
        }
        return {
          id: saved.id,
          original_filename: saved.originalFilename,
          mime_type: saved.mimeType,
          size_bytes: saved.sizeBytes,
          kind: saved.kind,
          created_at: saved.createdAt ?? null,
        };
      });
    } catch (error) {
      await cleanupUploadedObjects(bucket, uploadedStorageKeys);
      throw error;
    }

    return NextResponse.json({ attachments: createdAttachments }, { status: 201 });
  } catch (error) {
    console.error("Error uploading attachments:", error);
    const status = error instanceof AttachmentValidationError ? 400 : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to upload attachments" },
      { status },
    );
  }
}

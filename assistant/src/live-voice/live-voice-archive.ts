import { existsSync, statSync } from "node:fs";

import {
  attachFileBackedAttachmentToMessage,
  attachInlineAttachmentToMessage,
  attachmentExists,
  getAttachmentById,
  linkAttachmentToMessage,
} from "../memory/attachments-store.js";
import { rawAll, rawGet, rawRun } from "../memory/raw-query.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("live-voice-archive");

const LIVE_VOICE_AUDIO_METADATA_KEY = "liveVoiceAudioArtifacts";
const LIVE_VOICE_AUDIO_SOURCE = "live-voice";

export type LiveVoiceAudioArchiveRole = "user" | "assistant";

type LiveVoiceAudioSource =
  | {
      type: "base64";
      dataBase64: string;
    }
  | {
      type: "file";
      filePath: string;
      sizeBytes?: number;
    };

interface ArchiveLiveVoiceAudioInput {
  messageId: string;
  sessionId: string;
  turnId: string;
  role: LiveVoiceAudioArchiveRole;
  mimeType: string;
  sampleRate?: number;
  durationMs?: number;
  audio: LiveVoiceAudioSource;
  position?: number;
}

export interface LiveVoiceAudioArtifactMetadata {
  source: typeof LIVE_VOICE_AUDIO_SOURCE;
  archiveKey: string;
  attachmentId: string;
  sessionId: string;
  turnId: string;
  role: LiveVoiceAudioArchiveRole;
  mimeType: string;
  sampleRate?: number;
  durationMs?: number;
  sizeBytes: number;
  filename: string;
  archivedAt: number;
}

type LiveVoiceAudioArchiveWarningCode =
  | "archive_failed"
  | "attachment_not_found"
  | "invalid_audio_source"
  | "invalid_metadata"
  | "link_failed"
  | "message_id_unavailable"
  | "message_not_found"
  | "unsupported_mime_type";

export interface LiveVoiceAudioArchiveWarning {
  code: LiveVoiceAudioArchiveWarningCode;
  message: string;
}

export type LiveVoiceAudioArchiveResult =
  | {
      type: "archived";
      artifact: LiveVoiceAudioArtifactMetadata;
      idempotent: boolean;
    }
  | {
      type: "unlinked";
      warning: LiveVoiceAudioArchiveWarning;
      sessionId: string;
      turnId: string;
      role: LiveVoiceAudioArchiveRole;
      artifact?: LiveVoiceAudioArtifactMetadata;
    }
  | {
      type: "warning";
      warning: LiveVoiceAudioArchiveWarning;
    };

interface LiveVoiceAudioUnlinkedContext {
  sessionId: string;
  turnId: string;
  role: LiveVoiceAudioArchiveRole;
  artifact?: LiveVoiceAudioArtifactMetadata;
}

interface AttachmentLookupRow {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
}

interface MessageMetadataState {
  metadata: Record<string, unknown>;
  artifacts: LiveVoiceAudioArtifactMetadata[];
}

const AUDIO_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/pcm": "pcm",
  "audio/raw": "raw",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/x-m4a": "m4a",
  "audio/x-mulaw": "wav",
  "audio/x-wav": "wav",
};

function resultWarning(
  code: LiveVoiceAudioArchiveWarningCode,
  message: string,
): LiveVoiceAudioArchiveResult {
  return { type: "warning", warning: { code, message } };
}

function resultUnlinked(
  code: LiveVoiceAudioArchiveWarningCode,
  message: string,
  input: LiveVoiceAudioUnlinkedContext,
): LiveVoiceAudioArchiveResult {
  return {
    type: "unlinked",
    warning: { code, message },
    sessionId: input.sessionId,
    turnId: input.turnId,
    role: input.role,
    ...(input.artifact ? { artifact: input.artifact } : {}),
  };
}

function unlinkedContextForArtifact(
  artifact: LiveVoiceAudioArtifactMetadata,
): LiveVoiceAudioUnlinkedContext {
  return {
    sessionId: artifact.sessionId,
    turnId: artifact.turnId,
    role: artifact.role,
    artifact,
  };
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.toLowerCase().trim().split(";")[0]?.trim() ?? "";
}

function sanitizeFilenamePart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.slice(0, 80) || "unknown";
}

function buildArchiveKey(input: {
  sessionId: string;
  turnId: string;
  role: LiveVoiceAudioArchiveRole;
}): string {
  return `${LIVE_VOICE_AUDIO_SOURCE}:${input.sessionId}:${input.turnId}:${input.role}`;
}

function buildFilenameStem(input: {
  sessionId: string;
  turnId: string;
  role: LiveVoiceAudioArchiveRole;
}): string {
  return [
    "live-voice",
    input.role,
    sanitizeFilenamePart(input.sessionId),
    sanitizeFilenamePart(input.turnId),
  ].join("-");
}

function extensionForAudioMimeType(mimeType: string): string {
  const mapped = AUDIO_EXTENSION_BY_MIME_TYPE[mimeType];
  if (mapped) return mapped;
  const subtype = mimeType.slice("audio/".length);
  return sanitizeFilenamePart(subtype.replace(/^x-/, "")) || "audio";
}

function buildFilename(input: {
  sessionId: string;
  turnId: string;
  role: LiveVoiceAudioArchiveRole;
  mimeType: string;
}): string {
  return `${buildFilenameStem(input)}.${extensionForAudioMimeType(
    input.mimeType,
  )}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLiveVoiceRole(value: unknown): value is LiveVoiceAudioArchiveRole {
  return value === "user" || value === "assistant";
}

function isArtifactMetadata(
  value: unknown,
): value is LiveVoiceAudioArtifactMetadata {
  if (!isRecord(value)) return false;
  return (
    value.source === LIVE_VOICE_AUDIO_SOURCE &&
    typeof value.archiveKey === "string" &&
    typeof value.attachmentId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.turnId === "string" &&
    isLiveVoiceRole(value.role) &&
    typeof value.mimeType === "string" &&
    typeof value.sizeBytes === "number" &&
    typeof value.filename === "string" &&
    typeof value.archivedAt === "number"
  );
}

function readMessageMetadata(
  messageId: string,
): MessageMetadataState | "not_found" | "invalid_metadata" {
  const row = rawGet<{ metadata: string | null }>(
    `SELECT metadata FROM messages WHERE id = ?`,
    messageId,
  );
  if (!row) return "not_found";

  if (!row.metadata) {
    return { metadata: {}, artifacts: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.metadata);
  } catch {
    return "invalid_metadata";
  }

  if (!isRecord(parsed)) {
    return "invalid_metadata";
  }

  const rawArtifacts = parsed[LIVE_VOICE_AUDIO_METADATA_KEY];
  const artifacts = Array.isArray(rawArtifacts)
    ? rawArtifacts.filter(isArtifactMetadata)
    : [];

  return { metadata: parsed, artifacts };
}

function messageAttachmentLinkExists(
  messageId: string,
  attachmentId: string,
): boolean {
  const row = rawGet<{ id: string }>(
    `SELECT id
     FROM message_attachments
     WHERE message_id = ? AND attachment_id = ?
     LIMIT 1`,
    messageId,
    attachmentId,
  );
  return !!row;
}

function findExistingMetadataArtifact(
  messageId: string,
  archiveKey: string,
  artifacts: LiveVoiceAudioArtifactMetadata[],
): LiveVoiceAudioArtifactMetadata | null {
  const artifact = artifacts.find((candidate) => {
    return (
      candidate.archiveKey === archiveKey &&
      messageAttachmentLinkExists(messageId, candidate.attachmentId)
    );
  });
  return artifact ?? null;
}

function findExistingAttachmentByFilename(
  messageId: string,
  filenameStem: string,
): AttachmentLookupRow | null {
  const rows = rawAll<AttachmentLookupRow>(
    `SELECT
       a.id AS id,
       a.original_filename AS originalFilename,
       a.mime_type AS mimeType,
       a.size_bytes AS sizeBytes,
       a.created_at AS createdAt
     FROM attachments a
     JOIN message_attachments ma ON ma.attachment_id = a.id
     WHERE ma.message_id = ?
     ORDER BY ma.position ASC, a.created_at ASC`,
    messageId,
  );

  return (
    rows.find((row) => row.originalFilename.startsWith(`${filenameStem}.`)) ??
    null
  );
}

function nextAttachmentPosition(messageId: string): number {
  const row = rawGet<{ nextPosition: number | null }>(
    `SELECT COALESCE(MAX(position) + 1, 0) AS nextPosition
     FROM message_attachments
     WHERE message_id = ?`,
    messageId,
  );
  return row?.nextPosition ?? 0;
}

function persistArtifactMetadata(
  messageId: string,
  artifact: LiveVoiceAudioArtifactMetadata,
): boolean {
  const state = readMessageMetadata(messageId);
  if (state === "not_found" || state === "invalid_metadata") return false;

  const nextArtifacts = [
    ...state.artifacts.filter(
      (candidate) => candidate.archiveKey !== artifact.archiveKey,
    ),
    artifact,
  ];

  rawRun(
    `UPDATE messages SET metadata = ? WHERE id = ?`,
    JSON.stringify({
      ...state.metadata,
      [LIVE_VOICE_AUDIO_METADATA_KEY]: nextArtifacts,
    }),
    messageId,
  );
  return true;
}

function sanitizeOptionalPositiveNumber(
  value: number | undefined,
): number | undefined {
  if (value == null) return undefined;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function validateInput(input: ArchiveLiveVoiceAudioInput):
  | {
      archiveKey: string;
      filename: string;
      filenameStem: string;
      mimeType: string;
      sampleRate: number | undefined;
      durationMs: number | undefined;
    }
  | LiveVoiceAudioArchiveResult {
  if (!input.sessionId.trim() || !input.turnId.trim()) {
    return resultWarning(
      "invalid_metadata",
      "Live voice audio archive requires a session id and turn id.",
    );
  }

  if (!isLiveVoiceRole(input.role)) {
    return resultWarning(
      "invalid_metadata",
      "Live voice audio archive requires a user or assistant role.",
    );
  }

  const mimeType = normalizeMimeType(input.mimeType);
  if (!mimeType.startsWith("audio/")) {
    return resultWarning(
      "unsupported_mime_type",
      "Live voice audio archive only accepts audio MIME types.",
    );
  }

  if (
    input.sampleRate != null &&
    (!Number.isFinite(input.sampleRate) || input.sampleRate <= 0)
  ) {
    return resultWarning(
      "invalid_metadata",
      "Live voice audio archive sample rate must be a positive finite number.",
    );
  }

  if (
    input.durationMs != null &&
    (!Number.isFinite(input.durationMs) || input.durationMs <= 0)
  ) {
    return resultWarning(
      "invalid_metadata",
      "Live voice audio archive duration must be a positive finite number.",
    );
  }

  const archiveKey = buildArchiveKey(input);
  const filenameStem = buildFilenameStem(input);
  return {
    archiveKey,
    filename: buildFilename({ ...input, mimeType }),
    filenameStem,
    mimeType,
    sampleRate: sanitizeOptionalPositiveNumber(input.sampleRate),
    durationMs: sanitizeOptionalPositiveNumber(input.durationMs),
  };
}

function artifactFromAttachment(input: {
  attachmentId: string;
  archiveKey: string;
  sessionId: string;
  turnId: string;
  role: LiveVoiceAudioArchiveRole;
  mimeType: string;
  sampleRate?: number;
  durationMs?: number;
  sizeBytes: number;
  filename: string;
  archivedAt: number;
}): LiveVoiceAudioArtifactMetadata {
  return {
    source: LIVE_VOICE_AUDIO_SOURCE,
    archiveKey: input.archiveKey,
    attachmentId: input.attachmentId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    role: input.role,
    mimeType: input.mimeType,
    ...(input.sampleRate != null ? { sampleRate: input.sampleRate } : {}),
    ...(input.durationMs != null ? { durationMs: input.durationMs } : {}),
    sizeBytes: input.sizeBytes,
    filename: input.filename,
    archivedAt: input.archivedAt,
  };
}

export function archiveLiveVoiceAudioArtifact(
  input: ArchiveLiveVoiceAudioInput,
): LiveVoiceAudioArchiveResult {
  const validated = validateInput(input);
  if ("type" in validated) return validated;

  const state = readMessageMetadata(input.messageId);
  if (state === "not_found") {
    return resultWarning(
      "message_not_found",
      "Live voice audio archive target message was not found.",
    );
  }
  if (state === "invalid_metadata") {
    return resultWarning(
      "invalid_metadata",
      "Live voice audio archive target message metadata is invalid.",
    );
  }

  const existingMetadataArtifact = findExistingMetadataArtifact(
    input.messageId,
    validated.archiveKey,
    state.artifacts,
  );
  if (existingMetadataArtifact) {
    return {
      type: "archived",
      artifact: existingMetadataArtifact,
      idempotent: true,
    };
  }

  const existingAttachment = findExistingAttachmentByFilename(
    input.messageId,
    validated.filenameStem,
  );
  if (existingAttachment) {
    const artifact = artifactFromAttachment({
      attachmentId: existingAttachment.id,
      archiveKey: validated.archiveKey,
      sessionId: input.sessionId,
      turnId: input.turnId,
      role: input.role,
      mimeType: existingAttachment.mimeType,
      sampleRate: validated.sampleRate,
      durationMs: validated.durationMs,
      sizeBytes: existingAttachment.sizeBytes,
      filename: existingAttachment.originalFilename,
      archivedAt: existingAttachment.createdAt,
    });
    persistArtifactMetadata(input.messageId, artifact);
    return { type: "archived", artifact, idempotent: true };
  }

  try {
    const position = input.position ?? nextAttachmentPosition(input.messageId);
    const stored =
      input.audio.type === "base64"
        ? attachInlineAttachmentToMessage(
            input.messageId,
            position,
            validated.filename,
            validated.mimeType,
            input.audio.dataBase64,
          )
        : (() => {
            if (!existsSync(input.audio.filePath)) {
              return null;
            }
            const sizeBytes =
              input.audio.sizeBytes ?? statSync(input.audio.filePath).size;
            return attachFileBackedAttachmentToMessage(
              input.messageId,
              position,
              validated.filename,
              validated.mimeType,
              input.audio.filePath,
              sizeBytes,
            );
          })();

    if (!stored) {
      return resultWarning(
        "invalid_audio_source",
        "Live voice audio file is not readable.",
      );
    }

    const artifact = artifactFromAttachment({
      attachmentId: stored.id,
      archiveKey: validated.archiveKey,
      sessionId: input.sessionId,
      turnId: input.turnId,
      role: input.role,
      mimeType: validated.mimeType,
      sampleRate: validated.sampleRate,
      durationMs: validated.durationMs,
      sizeBytes: stored.sizeBytes,
      filename: stored.originalFilename,
      archivedAt: stored.createdAt,
    });
    if (!persistArtifactMetadata(input.messageId, artifact)) {
      log.warn(
        { messageId: input.messageId, archiveKey: validated.archiveKey },
        "Archived live voice audio but could not persist metadata",
      );
    }

    return { type: "archived", artifact, idempotent: false };
  } catch (err) {
    log.warn(
      {
        messageId: input.messageId,
        archiveKey: validated.archiveKey,
        errorName: err instanceof Error ? err.name : typeof err,
      },
      "Failed to archive live voice audio artifact",
    );
    return resultWarning(
      "archive_failed",
      "Live voice audio archive failed without blocking the turn.",
    );
  }
}

type ArchiveLiveVoiceRolelessAudioInput = Omit<
  ArchiveLiveVoiceAudioInput,
  "role"
>;

type LinkLiveVoiceRolelessAudioInput = Omit<
  ArchiveLiveVoiceAudioInput,
  "messageId" | "role"
> & {
  messageId?: string | null;
};

interface LinkLiveVoiceAudioArtifactInput {
  messageId?: string | null;
  artifact: LiveVoiceAudioArtifactMetadata;
  position?: number;
}

export function archiveLiveVoiceUserUtteranceAudio(
  input: ArchiveLiveVoiceRolelessAudioInput,
): LiveVoiceAudioArchiveResult {
  return archiveLiveVoiceAudioArtifact({ ...input, role: "user" });
}

export function archiveLiveVoiceAssistantResponseAudio(
  input: ArchiveLiveVoiceRolelessAudioInput,
): LiveVoiceAudioArchiveResult {
  return archiveLiveVoiceAudioArtifact({ ...input, role: "assistant" });
}

function normalizeMessageId(messageId: string | null | undefined): string {
  return messageId?.trim() ?? "";
}

function linkLiveVoiceAudioToMessage(
  input: LinkLiveVoiceRolelessAudioInput & {
    role: LiveVoiceAudioArchiveRole;
  },
): LiveVoiceAudioArchiveResult {
  const messageId = normalizeMessageId(input.messageId);
  if (!messageId) {
    return resultUnlinked(
      "message_id_unavailable",
      "Live voice audio archive could not be linked because no message id was available.",
      input,
    );
  }

  const { messageId: _messageId, ...archiveInput } = input;
  return archiveLiveVoiceAudioArtifact({
    ...archiveInput,
    messageId,
  });
}

export function linkLiveVoiceUserUtteranceAudioToMessage(
  input: LinkLiveVoiceRolelessAudioInput,
): LiveVoiceAudioArchiveResult {
  return linkLiveVoiceAudioToMessage({ ...input, role: "user" });
}

export function linkLiveVoiceAssistantResponseAudioToMessage(
  input: LinkLiveVoiceRolelessAudioInput,
): LiveVoiceAudioArchiveResult {
  return linkLiveVoiceAudioToMessage({ ...input, role: "assistant" });
}

export function linkLiveVoiceAudioArtifactToMessage(
  input: LinkLiveVoiceAudioArtifactInput,
): LiveVoiceAudioArchiveResult {
  const { artifact } = input;
  if (!isArtifactMetadata(artifact)) {
    return resultWarning(
      "invalid_metadata",
      "Live voice audio archive artifact metadata is invalid.",
    );
  }

  const messageId = normalizeMessageId(input.messageId);
  if (!messageId) {
    return resultUnlinked(
      "message_id_unavailable",
      "Live voice audio archive could not be linked because no message id was available.",
      unlinkedContextForArtifact(artifact),
    );
  }

  const state = readMessageMetadata(messageId);
  if (state === "not_found") {
    return resultUnlinked(
      "message_not_found",
      "Live voice audio archive target message was not found.",
      unlinkedContextForArtifact(artifact),
    );
  }
  if (state === "invalid_metadata") {
    return resultUnlinked(
      "invalid_metadata",
      "Live voice audio archive target message metadata is invalid.",
      unlinkedContextForArtifact(artifact),
    );
  }

  const existingMetadataArtifact = findExistingMetadataArtifact(
    messageId,
    artifact.archiveKey,
    state.artifacts,
  );
  if (existingMetadataArtifact) {
    return {
      type: "archived",
      artifact: existingMetadataArtifact,
      idempotent: true,
    };
  }

  if (messageAttachmentLinkExists(messageId, artifact.attachmentId)) {
    persistArtifactMetadata(messageId, artifact);
    return { type: "archived", artifact, idempotent: true };
  }

  if (!attachmentExists(artifact.attachmentId)) {
    return resultUnlinked(
      "attachment_not_found",
      "Live voice audio archive attachment was not found.",
      unlinkedContextForArtifact(artifact),
    );
  }

  try {
    const linkedAttachmentId = linkAttachmentToMessage(
      messageId,
      artifact.attachmentId,
      input.position ?? nextAttachmentPosition(messageId),
    );
    const linkedAttachment = getAttachmentById(linkedAttachmentId);
    const linkedArtifact = linkedAttachment
      ? artifactFromAttachment({
          attachmentId: linkedAttachment.id,
          archiveKey: artifact.archiveKey,
          sessionId: artifact.sessionId,
          turnId: artifact.turnId,
          role: artifact.role,
          mimeType: linkedAttachment.mimeType,
          sampleRate: artifact.sampleRate,
          durationMs: artifact.durationMs,
          sizeBytes: linkedAttachment.sizeBytes,
          filename: linkedAttachment.originalFilename,
          archivedAt: linkedAttachment.createdAt,
        })
      : { ...artifact, attachmentId: linkedAttachmentId };

    if (!persistArtifactMetadata(messageId, linkedArtifact)) {
      log.warn(
        { messageId, archiveKey: artifact.archiveKey },
        "Linked live voice audio but could not persist metadata",
      );
    }

    return { type: "archived", artifact: linkedArtifact, idempotent: false };
  } catch (err) {
    log.warn(
      {
        messageId,
        attachmentId: artifact.attachmentId,
        archiveKey: artifact.archiveKey,
        errorName: err instanceof Error ? err.name : typeof err,
      },
      "Failed to link live voice audio artifact",
    );
    return resultUnlinked(
      "link_failed",
      "Live voice audio archive could not be linked without blocking the turn.",
      unlinkedContextForArtifact(artifact),
    );
  }
}

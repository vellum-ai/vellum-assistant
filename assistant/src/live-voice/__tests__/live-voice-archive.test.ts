import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  getAttachmentContent,
  getAttachmentsForMessage,
} from "../../memory/attachments-store.js";
import {
  addMessage,
  createConversation,
} from "../../memory/conversation-crud.js";
import {
  getDb,
  initializeDb,
  rawAll,
  rawGet,
  rawRun,
} from "../../memory/db.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type { LiveVoiceAudioArtifactMetadata } from "../live-voice-archive.js";
import {
  archiveLiveVoiceAssistantResponseAudio,
  archiveLiveVoiceAudioArtifact,
  archiveLiveVoiceUserUtteranceAudio,
  linkLiveVoiceAssistantResponseAudioToMessage,
  linkLiveVoiceAudioArtifactToMessage,
  linkLiveVoiceUserUtteranceAudioToMessage,
} from "../live-voice-archive.js";

initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

async function createMessage(role: "user" | "assistant" = "user") {
  const conversation = createConversation();
  const message = await addMessage(
    conversation.id,
    role,
    role === "user" ? "Example user utterance" : "Example assistant response",
    role === "user"
      ? { userMessageChannel: "vellum", userMessageInterface: "macos" }
      : {
          assistantMessageChannel: "vellum",
          assistantMessageInterface: "macos",
        },
    { skipIndexing: true },
  );
  return { conversation, message };
}

function getMessageMetadata(messageId: string): Record<string, unknown> {
  const row = rawGet<{ metadata: string | null }>(
    `SELECT metadata FROM messages WHERE id = ?`,
    messageId,
  );
  expect(row).toBeDefined();
  return row?.metadata ? JSON.parse(row.metadata) : {};
}

function getLiveVoiceArtifacts(
  messageId: string,
): LiveVoiceAudioArtifactMetadata[] {
  const metadata = getMessageMetadata(messageId);
  expect(Array.isArray(metadata.liveVoiceAudioArtifacts)).toBe(true);
  return metadata.liveVoiceAudioArtifacts as LiveVoiceAudioArtifactMetadata[];
}

function countAttachmentsForMessage(messageId: string): number {
  const row = rawGet<{ count: number }>(
    `SELECT COUNT(*) AS count FROM message_attachments WHERE message_id = ?`,
    messageId,
  );
  return row?.count ?? 0;
}

function countAllAttachments(): number {
  const row = rawGet<{ count: number }>(
    `SELECT COUNT(*) AS count FROM attachments`,
  );
  return row?.count ?? 0;
}

describe("live voice audio archive", () => {
  beforeEach(resetTables);

  test("archives user utterance audio through the attachment store", async () => {
    const { message } = await createMessage("user");
    const audio = Buffer.from("user audio bytes");

    const result = archiveLiveVoiceUserUtteranceAudio({
      messageId: message.id,
      sessionId: "session-123",
      turnId: "turn-abc",
      mimeType: "audio/wav",
      sampleRate: 16000,
      durationMs: 1250,
      audio: {
        type: "base64",
        dataBase64: audio.toString("base64"),
      },
    });

    expect(result.type).toBe("archived");
    if (result.type !== "archived") throw new Error("expected archive result");
    expect(result.idempotent).toBe(false);
    expect(result.artifact).toMatchObject({
      source: "live-voice",
      archiveKey: "live-voice:session-123:turn-abc:user",
      sessionId: "session-123",
      turnId: "turn-abc",
      role: "user",
      mimeType: "audio/wav",
      sampleRate: 16000,
      durationMs: 1250,
      filename: "live-voice-user-session-123-turn-abc.wav",
    });

    expect(getAttachmentContent(result.artifact.attachmentId)).toEqual(audio);

    const attachments = getAttachmentsForMessage(message.id);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.id).toBe(result.artifact.attachmentId);
    expect(attachments[0]?.originalFilename).toBe(
      "live-voice-user-session-123-turn-abc.wav",
    );
    expect(attachments[0]?.mimeType).toBe("audio/wav");

    const artifacts = getLiveVoiceArtifacts(message.id);
    expect(artifacts).toEqual([result.artifact]);
  });

  test("archives assistant spoken response audio from a file-backed source", async () => {
    const { message } = await createMessage("assistant");
    const audioDir = join(getWorkspaceDir(), "tmp-audio");
    mkdirSync(audioDir, { recursive: true });
    const sourcePath = join(audioDir, "assistant-response.mp3");
    const audio = Buffer.from("assistant audio bytes");
    writeFileSync(sourcePath, audio);

    const result = archiveLiveVoiceAssistantResponseAudio({
      messageId: message.id,
      sessionId: "session-456",
      turnId: "turn-def",
      mimeType: "audio/mpeg",
      sampleRate: 24000,
      durationMs: 980,
      audio: {
        type: "file",
        filePath: sourcePath,
      },
    });

    expect(result.type).toBe("archived");
    if (result.type !== "archived") throw new Error("expected archive result");
    expect(result.artifact).toMatchObject({
      role: "assistant",
      mimeType: "audio/mpeg",
      filename: "live-voice-assistant-session-456-turn-def.mp3",
      sizeBytes: audio.length,
    });

    const row = rawGet<{
      dataBase64: string;
      filePath: string | null;
      sourcePath: string | null;
    }>(
      `SELECT
         data_base64 AS dataBase64,
         file_path AS filePath,
         source_path AS sourcePath
       FROM attachments
       WHERE id = ?`,
      result.artifact.attachmentId,
    );
    expect(row?.dataBase64).toBe("");
    expect(row?.filePath).toBeTruthy();
    expect(row?.filePath).not.toBe(sourcePath);
    expect(row?.sourcePath).toBe(sourcePath);
    expect(existsSync(row!.filePath!)).toBe(true);
    expect(readFileSync(row!.filePath!)).toEqual(audio);

    const serializedMetadata = JSON.stringify(getMessageMetadata(message.id));
    expect(serializedMetadata).not.toContain(sourcePath);
    expect(serializedMetadata).not.toContain("api_key");
    expect(serializedMetadata).not.toContain("providerConfig");
  });

  test("links user utterance audio to a persisted user message id", async () => {
    const { message } = await createMessage("user");

    const result = linkLiveVoiceUserUtteranceAudioToMessage({
      messageId: message.id,
      sessionId: "session-user-link",
      turnId: "turn-user-link",
      mimeType: "audio/wav",
      audio: {
        type: "base64",
        dataBase64: Buffer.from("linked user audio").toString("base64"),
      },
    });

    expect(result.type).toBe("archived");
    if (result.type !== "archived") throw new Error("expected archive result");
    expect(result.artifact).toMatchObject({
      archiveKey: "live-voice:session-user-link:turn-user-link:user",
      role: "user",
    });
    expect(getAttachmentsForMessage(message.id)).toHaveLength(1);
    expect(getLiveVoiceArtifacts(message.id)).toEqual([result.artifact]);
  });

  test("links assistant response audio when the assistant message id is available", async () => {
    const { message } = await createMessage("assistant");

    const result = linkLiveVoiceAssistantResponseAudioToMessage({
      messageId: message.id,
      sessionId: "session-assistant-link",
      turnId: "turn-assistant-link",
      mimeType: "audio/pcm",
      sampleRate: 24000,
      audio: {
        type: "base64",
        dataBase64: Buffer.from("linked assistant audio").toString("base64"),
      },
    });

    expect(result.type).toBe("archived");
    if (result.type !== "archived") throw new Error("expected archive result");
    expect(result.artifact).toMatchObject({
      archiveKey:
        "live-voice:session-assistant-link:turn-assistant-link:assistant",
      role: "assistant",
      sampleRate: 24000,
    });
    expect(getAttachmentsForMessage(message.id)).toHaveLength(1);
    expect(getLiveVoiceArtifacts(message.id)).toEqual([result.artifact]);
  });

  test("returns an unlinked result when the assistant message id is unavailable", () => {
    const result = linkLiveVoiceAssistantResponseAudioToMessage({
      messageId: undefined,
      sessionId: "session-assistant-unlinked",
      turnId: "turn-assistant-unlinked",
      mimeType: "audio/pcm",
      audio: {
        type: "base64",
        dataBase64: Buffer.from("unlinked assistant audio").toString("base64"),
      },
    });

    expect(result).toEqual({
      type: "unlinked",
      warning: {
        code: "message_id_unavailable",
        message:
          "Live voice audio archive could not be linked because no message id was available.",
      },
      sessionId: "session-assistant-unlinked",
      turnId: "turn-assistant-unlinked",
      role: "assistant",
    });
    expect(countAllAttachments()).toBe(0);
  });

  test("is idempotent for the session turn role key", async () => {
    const { message } = await createMessage("user");

    const first = archiveLiveVoiceAudioArtifact({
      messageId: message.id,
      sessionId: "session-repeat",
      turnId: "turn-repeat",
      role: "user",
      mimeType: "audio/pcm",
      sampleRate: 48000,
      audio: {
        type: "base64",
        dataBase64: Buffer.from("first audio").toString("base64"),
      },
    });
    const second = archiveLiveVoiceAudioArtifact({
      messageId: message.id,
      sessionId: "session-repeat",
      turnId: "turn-repeat",
      role: "user",
      mimeType: "audio/pcm",
      sampleRate: 48000,
      audio: {
        type: "base64",
        dataBase64: Buffer.from("second audio").toString("base64"),
      },
    });

    expect(first.type).toBe("archived");
    expect(second.type).toBe("archived");
    if (first.type !== "archived" || second.type !== "archived") {
      throw new Error("expected archived results");
    }
    expect(second.idempotent).toBe(true);
    expect(second.artifact.attachmentId).toBe(first.artifact.attachmentId);
    expect(countAttachmentsForMessage(message.id)).toBe(1);
    expect(getAttachmentContent(first.artifact.attachmentId)?.toString()).toBe(
      "first audio",
    );

    const assistantResult = archiveLiveVoiceAudioArtifact({
      messageId: message.id,
      sessionId: "session-repeat",
      turnId: "turn-repeat",
      role: "assistant",
      mimeType: "audio/pcm",
      audio: {
        type: "base64",
        dataBase64: Buffer.from("assistant audio").toString("base64"),
      },
    });
    expect(assistantResult.type).toBe("archived");
    expect(countAttachmentsForMessage(message.id)).toBe(2);
  });

  test("restores metadata idempotency from the deterministic attachment filename", async () => {
    const { message } = await createMessage("assistant");
    const first = archiveLiveVoiceAssistantResponseAudio({
      messageId: message.id,
      sessionId: "session-crash",
      turnId: "turn-crash",
      mimeType: "audio/ogg",
      audio: {
        type: "base64",
        dataBase64: Buffer.from("archived before metadata loss").toString(
          "base64",
        ),
      },
    });
    expect(first.type).toBe("archived");
    if (first.type !== "archived") throw new Error("expected archive result");

    rawRun(`UPDATE messages SET metadata = NULL WHERE id = ?`, message.id);

    const second = archiveLiveVoiceAssistantResponseAudio({
      messageId: message.id,
      sessionId: "session-crash",
      turnId: "turn-crash",
      mimeType: "audio/ogg",
      audio: {
        type: "base64",
        dataBase64: Buffer.from("duplicate attempt").toString("base64"),
      },
    });

    expect(second.type).toBe("archived");
    if (second.type !== "archived") throw new Error("expected archive result");
    expect(second.idempotent).toBe(true);
    expect(second.artifact.attachmentId).toBe(first.artifact.attachmentId);
    expect(countAttachmentsForMessage(message.id)).toBe(1);
    expect(getLiveVoiceArtifacts(message.id)).toHaveLength(1);
  });

  test("links an existing archived audio artifact to another message id", async () => {
    const conversation = createConversation();
    const sourceMessage = await addMessage(
      conversation.id,
      "user",
      "Example source utterance",
      { userMessageChannel: "vellum", userMessageInterface: "macos" },
      { skipIndexing: true },
    );
    const targetMessage = await addMessage(
      conversation.id,
      "user",
      "Example target utterance",
      { userMessageChannel: "vellum", userMessageInterface: "macos" },
      { skipIndexing: true },
    );

    const archived = archiveLiveVoiceUserUtteranceAudio({
      messageId: sourceMessage.id,
      sessionId: "session-artifact-link",
      turnId: "turn-artifact-link",
      mimeType: "audio/wav",
      audio: {
        type: "base64",
        dataBase64: Buffer.from("existing artifact audio").toString("base64"),
      },
    });
    expect(archived.type).toBe("archived");
    if (archived.type !== "archived") {
      throw new Error("expected archive result");
    }

    const linked = linkLiveVoiceAudioArtifactToMessage({
      messageId: targetMessage.id,
      artifact: archived.artifact,
    });

    expect(linked.type).toBe("archived");
    if (linked.type !== "archived") throw new Error("expected link result");
    expect(linked.idempotent).toBe(false);
    expect(linked.artifact.attachmentId).toBe(archived.artifact.attachmentId);
    expect(getAttachmentsForMessage(targetMessage.id)).toHaveLength(1);
    expect(getLiveVoiceArtifacts(targetMessage.id)).toEqual([linked.artifact]);

    const second = linkLiveVoiceAudioArtifactToMessage({
      messageId: targetMessage.id,
      artifact: archived.artifact,
    });
    expect(second.type).toBe("archived");
    if (second.type !== "archived") throw new Error("expected link result");
    expect(second.idempotent).toBe(true);
    expect(countAttachmentsForMessage(targetMessage.id)).toBe(1);
  });

  test("returns typed warnings for non-fatal archive failures", async () => {
    const { message } = await createMessage("user");

    const missingFile = archiveLiveVoiceUserUtteranceAudio({
      messageId: message.id,
      sessionId: "session-warning",
      turnId: "turn-warning",
      mimeType: "audio/wav",
      audio: {
        type: "file",
        filePath: join(getWorkspaceDir(), "missing.wav"),
      },
    });
    expect(missingFile).toEqual({
      type: "warning",
      warning: {
        code: "invalid_audio_source",
        message: "Live voice audio file is not readable.",
      },
    });

    const unsupportedMime = archiveLiveVoiceUserUtteranceAudio({
      messageId: message.id,
      sessionId: "session-warning",
      turnId: "turn-warning-2",
      mimeType: "application/octet-stream",
      audio: {
        type: "base64",
        dataBase64: Buffer.from("not audio").toString("base64"),
      },
    });
    expect(unsupportedMime).toEqual({
      type: "warning",
      warning: {
        code: "unsupported_mime_type",
        message: "Live voice audio archive only accepts audio MIME types.",
      },
    });

    const missingMessage = archiveLiveVoiceUserUtteranceAudio({
      messageId: "missing-message",
      sessionId: "session-warning",
      turnId: "turn-warning-3",
      mimeType: "audio/wav",
      audio: {
        type: "base64",
        dataBase64: Buffer.from("audio").toString("base64"),
      },
    });
    expect(missingMessage.type).toBe("warning");
    if (missingMessage.type !== "warning") {
      throw new Error("expected warning result");
    }
    expect(missingMessage.warning.code).toBe("message_not_found");
    expect(countAttachmentsForMessage(message.id)).toBe(0);
  });

  test("keeps archive metadata scoped to allowed live voice fields", async () => {
    const { message } = await createMessage("assistant");

    const result = archiveLiveVoiceAssistantResponseAudio({
      messageId: message.id,
      sessionId: "session-metadata",
      turnId: "turn-metadata",
      mimeType: "audio/mp4",
      durationMs: 500,
      audio: {
        type: "base64",
        dataBase64: Buffer.from("metadata audio").toString("base64"),
      },
    });

    expect(result.type).toBe("archived");
    const [artifact] = getLiveVoiceArtifacts(message.id);
    expect(Object.keys(artifact!).sort()).toEqual([
      "archiveKey",
      "archivedAt",
      "attachmentId",
      "durationMs",
      "filename",
      "mimeType",
      "role",
      "sessionId",
      "sizeBytes",
      "source",
      "turnId",
    ]);

    const attachmentRows = rawAll<{
      originalFilename: string;
      mimeType: string;
    }>(
      `SELECT original_filename AS originalFilename, mime_type AS mimeType
       FROM attachments`,
    );
    expect(attachmentRows).toEqual([
      {
        originalFilename:
          "live-voice-assistant-session-metadata-turn-metadata.m4a",
        mimeType: "audio/mp4",
      },
    ]);
  });
});

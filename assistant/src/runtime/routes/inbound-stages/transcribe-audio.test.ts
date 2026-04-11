import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { BatchTranscriber } from "../../../stt/types.js";
import { SttError } from "../../../stt/types.js";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

let mockFeatureFlagEnabled = true;
let mockAttachments: Array<{
  id: string;
  mimeType: string;
  dataBase64: string;
  originalFilename: string;
  sizeBytes: number;
  kind: string;
  thumbnailBase64: string | null;
  createdAt: number;
}> = [];
let mockTranscriber: BatchTranscriber | null = null;

mock.module("../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => mockFeatureFlagEnabled,
}));

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({}),
}));

mock.module("../../../memory/attachments-store.js", () => ({
  getAttachmentsByIds: (ids: string[]) =>
    mockAttachments.filter((a) => ids.includes(a.id)),
  getAttachmentById: (id: string, _opts?: { hydrateFileData?: boolean }) =>
    mockAttachments.find((a) => a.id === id) ?? null,
}));

mock.module("../../../security/secure-keys.js", () => ({
  getProviderKeyAsync: async () => (mockTranscriber ? "fake-key" : null),
}));

mock.module("../../../stt/daemon-batch-transcriber.js", () => ({
  createDaemonBatchTranscriber: (apiKey: string | null | undefined) =>
    apiKey ? mockTranscriber : null,
  normalizeSttError: (err: unknown): SttError => {
    if (err instanceof SttError) return err;
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === "AbortError") {
      return new SttError("timeout", message);
    }
    return new SttError("provider-error", message);
  },
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// Import after mocks are installed
const { tryTranscribeAudioAttachments } = await import("./transcribe-audio.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAudioAttachment(
  id: string,
  mimeType = "audio/ogg",
  dataBase64 = Buffer.from("fake-audio-data").toString("base64"),
) {
  return {
    id,
    mimeType,
    dataBase64,
    originalFilename: `voice-${id}.ogg`,
    sizeBytes: Buffer.from(dataBase64, "base64").length,
    kind: "document" as const,
    thumbnailBase64: null,
    createdAt: Date.now(),
  };
}

function makeDocumentAttachment(id: string) {
  return {
    id,
    mimeType: "application/pdf",
    dataBase64: Buffer.from("fake-pdf").toString("base64"),
    originalFilename: `doc-${id}.pdf`,
    sizeBytes: 8,
    kind: "document" as const,
    thumbnailBase64: null,
    createdAt: Date.now(),
  };
}

function makeImageAttachment(id: string) {
  return {
    id,
    mimeType: "image/png",
    dataBase64: Buffer.from("fake-image").toString("base64"),
    originalFilename: `photo-${id}.png`,
    sizeBytes: 10,
    kind: "image" as const,
    thumbnailBase64: null,
    createdAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tryTranscribeAudioAttachments", () => {
  beforeEach(() => {
    mockFeatureFlagEnabled = true;
    mockAttachments = [];
    mockTranscriber = null;
  });

  afterEach(() => {
    mockAttachments = [];
  });

  test("audio attachment is transcribed and returns transcribed result", async () => {
    const audio = makeAudioAttachment("a1");
    mockAttachments = [audio];
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => ({ text: "Hello, how are you?" }),
    };

    const result = await tryTranscribeAudioAttachments(["a1"]);

    expect(result).toEqual({
      status: "transcribed",
      text: "Hello, how are you?",
    });
  });

  test("non-audio attachments return no_audio", async () => {
    const doc = makeDocumentAttachment("d1");
    const img = makeImageAttachment("i1");
    mockAttachments = [doc, img];
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => ({ text: "should not be called" }),
    };

    const result = await tryTranscribeAudioAttachments(["d1", "i1"]);

    expect(result).toEqual({ status: "no_audio" });
  });

  test("no API key returns no_provider with helpful reason string", async () => {
    const audio = makeAudioAttachment("a1");
    mockAttachments = [audio];
    mockTranscriber = null; // No transcriber resolved

    const result = await tryTranscribeAudioAttachments(["a1"]);

    expect(result.status).toBe("no_provider");
    expect((result as { reason: string }).reason).toContain(
      "No OpenAI API key configured",
    );
  });

  test("API failure returns error with reason", async () => {
    const audio = makeAudioAttachment("a1");
    mockAttachments = [audio];
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => {
        throw new Error("API rate limit exceeded");
      },
    };

    const result = await tryTranscribeAudioAttachments(["a1"]);

    expect(result.status).toBe("error");
    expect((result as { reason: string }).reason).toBe(
      "API rate limit exceeded",
    );
  });

  test("feature flag disabled returns disabled", async () => {
    mockFeatureFlagEnabled = false;
    const audio = makeAudioAttachment("a1");
    mockAttachments = [audio];

    const result = await tryTranscribeAudioAttachments(["a1"]);

    expect(result).toEqual({ status: "disabled" });
  });

  test("30-second timeout fires and returns error without blocking", async () => {
    const audio = makeAudioAttachment("a1");
    mockAttachments = [audio];
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => {
        throw new DOMException("The operation was aborted", "AbortError");
      },
    };

    const result = await tryTranscribeAudioAttachments(["a1"]);

    expect(result.status).toBe("error");
    expect((result as { reason: string }).reason).toBe(
      "Transcription timed out",
    );
  });

  test("multiple audio attachments are transcribed and concatenated", async () => {
    const a1 = makeAudioAttachment("a1");
    const a2 = makeAudioAttachment("a2", "audio/mpeg");
    mockAttachments = [a1, a2];

    let callCount = 0;
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => {
        callCount++;
        return { text: callCount === 1 ? "First message" : "Second message" };
      },
    };

    const result = await tryTranscribeAudioAttachments(["a1", "a2"]);

    expect(result).toEqual({
      status: "transcribed",
      text: "First message\n\nSecond message",
    });
    expect(callCount).toBe(2);
  });

  test("mixed audio and non-audio attachments: only audio is transcribed", async () => {
    const audio = makeAudioAttachment("a1");
    const doc = makeDocumentAttachment("d1");
    mockAttachments = [audio, doc];

    let transcribeCallCount = 0;
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => {
        transcribeCallCount++;
        return { text: "Voice transcription" };
      },
    };

    const result = await tryTranscribeAudioAttachments(["a1", "d1"]);

    expect(result).toEqual({
      status: "transcribed",
      text: "Voice transcription",
    });
    expect(transcribeCallCount).toBe(1);
  });

  test("empty attachment IDs returns no_audio", async () => {
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => ({ text: "should not be called" }),
    };

    const result = await tryTranscribeAudioAttachments([]);

    expect(result).toEqual({ status: "no_audio" });
  });

  test("attachment with empty transcription returns no_audio", async () => {
    const audio = makeAudioAttachment("a1");
    mockAttachments = [audio];
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => ({ text: "   " }), // whitespace-only
    };

    const result = await tryTranscribeAudioAttachments(["a1"]);

    expect(result).toEqual({ status: "no_audio" });
  });
});

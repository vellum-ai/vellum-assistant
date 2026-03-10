import { createHash } from "crypto";

export type EmbeddingTaskType =
  | "SEMANTIC_SIMILARITY"
  | "CLASSIFICATION"
  | "CLUSTERING"
  | "RETRIEVAL_DOCUMENT"
  | "RETRIEVAL_QUERY"
  | "CODE_RETRIEVAL_QUERY"
  | "QUESTION_ANSWERING"
  | "FACT_VERIFICATION";

export interface TextEmbeddingInput {
  type: "text";
  text: string;
}

export interface ImageEmbeddingInput {
  type: "image";
  data: Buffer;
  mimeType: string; // "image/png" | "image/jpeg"
}

export interface AudioEmbeddingInput {
  type: "audio";
  data: Buffer;
  mimeType: string; // "audio/mp3" | "audio/wav"
}

export interface VideoEmbeddingInput {
  type: "video";
  data: Buffer;
  mimeType: string; // "video/mp4" | "video/mov"
}

export type MultimodalEmbeddingInput =
  | TextEmbeddingInput
  | ImageEmbeddingInput
  | AudioEmbeddingInput
  | VideoEmbeddingInput;

/** Accepts raw strings as shorthand for text inputs. */
export type EmbeddingInput = string | MultimodalEmbeddingInput;

export function normalizeEmbeddingInput(input: EmbeddingInput): MultimodalEmbeddingInput {
  if (typeof input === "string") return { type: "text", text: input };
  return input;
}

export function embeddingInputContentHash(input: EmbeddingInput): string {
  const normalized = normalizeEmbeddingInput(input);
  const hash = createHash("sha256");
  hash.update(normalized.type);
  if (normalized.type === "text") {
    hash.update(normalized.text);
  } else {
    hash.update(normalized.mimeType);
    hash.update(normalized.data);
  }
  return hash.digest("hex");
}

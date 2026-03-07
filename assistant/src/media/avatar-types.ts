export type AvatarGenerationStrategy = "managed_required" | "managed_prefer" | "local_only";

export interface ManagedAvatarImagePayload {
  mime_type: string;
  data_base64: string;
  bytes: number;
  sha256: string;
}

export interface ManagedAvatarResponse {
  image: ManagedAvatarImagePayload;
  usage: { billable: boolean; class_name: string };
  generation_source: string;
  profile: string;
  correlation_id: string;
}

export interface ManagedAvatarErrorResponse {
  code: string;
  subcode: string;
  detail: string;
  retryable: boolean;
  correlation_id: string;
}

export class ManagedAvatarError extends Error {
  readonly code: string;
  readonly subcode: string;
  readonly retryable: boolean;
  readonly correlationId: string;
  readonly statusCode: number;

  constructor(opts: {
    code: string;
    subcode: string;
    detail: string;
    retryable: boolean;
    correlationId: string;
    statusCode: number;
  }) {
    super(opts.detail);
    this.name = "ManagedAvatarError";
    this.code = opts.code;
    this.subcode = opts.subcode;
    this.retryable = opts.retryable;
    this.correlationId = opts.correlationId;
    this.statusCode = opts.statusCode;
  }
}

export interface AvatarGenerationResult {
  imageBase64: string;
  mimeType: string;
  pathUsed: "managed" | "local";
  correlationId?: string;
}

export const AVATAR_MIME_ALLOWLIST = new Set(["image/png", "image/jpeg", "image/webp"]);
export const AVATAR_MAX_DECODED_BYTES = 10 * 1024 * 1024;
export const AVATAR_PROMPT_MAX_LENGTH = 2000;

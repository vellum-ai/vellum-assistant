export type CdpErrorCode =
  | "cdp_error" // JSON-RPC error returned by CDP
  | "transport_error" // underlying transport failed (socket closed, timeout)
  | "aborted" // caller-provided AbortSignal fired
  | "disposed"; // client.dispose() already called

/**
 * Single error type thrown by all CdpClient implementations. Carries
 * the offending CDP method + params for logging and a stable code so
 * callers can branch without string-sniffing.
 */
export class CdpError extends Error {
  readonly code: CdpErrorCode;
  readonly cdpMethod?: string;
  readonly cdpParams?: Record<string, unknown>;
  readonly underlying?: unknown;

  constructor(
    code: CdpErrorCode,
    message: string,
    details?: {
      cdpMethod?: string;
      cdpParams?: Record<string, unknown>;
      underlying?: unknown;
    },
  ) {
    super(message);
    this.name = "CdpError";
    this.code = code;
    this.cdpMethod = details?.cdpMethod;
    this.cdpParams = details?.cdpParams;
    this.underlying = details?.underlying;
  }
}

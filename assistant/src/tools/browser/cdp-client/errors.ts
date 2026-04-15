import type { AttemptDiagnostic } from "./types.js";

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

  /**
   * Structured attempt diagnostics from the factory's failover walk.
   * Present when the error is thrown by the factory after walking one
   * or more candidates. Each entry describes a single candidate
   * attempt with the kind, stage, and failure reason.
   *
   * Higher layers (e.g. tool-response formatting) can use this to
   * render detailed failure information with remediation hints.
   */
  readonly attemptDiagnostics?: readonly AttemptDiagnostic[];

  constructor(
    code: CdpErrorCode,
    message: string,
    details?: {
      cdpMethod?: string;
      cdpParams?: Record<string, unknown>;
      underlying?: unknown;
      attemptDiagnostics?: readonly AttemptDiagnostic[];
    },
  ) {
    super(message);
    this.name = "CdpError";
    this.code = code;
    this.cdpMethod = details?.cdpMethod;
    this.cdpParams = details?.cdpParams;
    this.underlying = details?.underlying;
    this.attemptDiagnostics = details?.attemptDiagnostics;
  }
}

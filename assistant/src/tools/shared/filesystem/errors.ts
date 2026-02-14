/**
 * Normalized error codes and structured error type for filesystem operations.
 *
 * Every filesystem error is represented as a FilesystemError with a code that
 * allows callers to branch on the failure reason without parsing message strings.
 */

export const FilesystemErrorCode = {
  /** The path argument is missing or not a string. */
  INVALID_PATH: 'INVALID_PATH',
  /** The resolved path escapes the allowed working directory boundary. */
  PATH_OUT_OF_BOUNDS: 'PATH_OUT_OF_BOUNDS',
  /** An absolute path was required but a relative path was provided. */
  PATH_NOT_ABSOLUTE: 'PATH_NOT_ABSOLUTE',
  /** The target file or directory does not exist. */
  NOT_FOUND: 'NOT_FOUND',
  /** The path points to a directory when a file was expected. */
  NOT_A_FILE: 'NOT_A_FILE',
  /** The file or content exceeds the configured size limit. */
  SIZE_LIMIT_EXCEEDED: 'SIZE_LIMIT_EXCEEDED',
  /** The search string was not found in the file (edit operation). */
  MATCH_NOT_FOUND: 'MATCH_NOT_FOUND',
  /** The search string matches multiple locations and a unique match was required. */
  MATCH_AMBIGUOUS: 'MATCH_AMBIGUOUS',
  /** A low-level I/O error (permission denied, read-only FS, etc.). */
  IO_ERROR: 'IO_ERROR',
} as const;

export type FilesystemErrorCode = (typeof FilesystemErrorCode)[keyof typeof FilesystemErrorCode];

export class FilesystemError extends Error {
  readonly code: FilesystemErrorCode;
  /** The path involved in the error, if available. */
  readonly path?: string;

  constructor(code: FilesystemErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'FilesystemError';
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Helper constructors — one per error code for concise call sites.
// ---------------------------------------------------------------------------

export function invalidPath(detail: string): FilesystemError {
  return new FilesystemError(FilesystemErrorCode.INVALID_PATH, detail);
}

export function pathOutOfBounds(rawPath: string, resolved: string, boundary: string): FilesystemError {
  return new FilesystemError(
    FilesystemErrorCode.PATH_OUT_OF_BOUNDS,
    `Path "${rawPath}" resolves to "${resolved}" which is outside the working directory "${boundary}"`,
    resolved,
  );
}

export function pathNotAbsolute(rawPath: string): FilesystemError {
  return new FilesystemError(
    FilesystemErrorCode.PATH_NOT_ABSOLUTE,
    `Expected an absolute path but received "${rawPath}"`,
    rawPath,
  );
}

export function notFound(filePath: string): FilesystemError {
  return new FilesystemError(
    FilesystemErrorCode.NOT_FOUND,
    `File not found: ${filePath}`,
    filePath,
  );
}

export function notAFile(filePath: string): FilesystemError {
  return new FilesystemError(
    FilesystemErrorCode.NOT_A_FILE,
    `${filePath} is a directory, not a file`,
    filePath,
  );
}

export function sizeLimitExceeded(filePath: string, actualBytes: number, limitBytes: number): FilesystemError {
  return new FilesystemError(
    FilesystemErrorCode.SIZE_LIMIT_EXCEEDED,
    `Size (${formatBytes(actualBytes)}) exceeds the ${formatBytes(limitBytes)} limit: ${filePath}`,
    filePath,
  );
}

export function matchNotFound(filePath: string): FilesystemError {
  return new FilesystemError(
    FilesystemErrorCode.MATCH_NOT_FOUND,
    `old_string not found in ${filePath}`,
    filePath,
  );
}

export function matchAmbiguous(filePath: string, count: number): FilesystemError {
  return new FilesystemError(
    FilesystemErrorCode.MATCH_AMBIGUOUS,
    `old_string appears ${count} times in ${filePath}. Provide more surrounding context to make it unique, or set replace_all to true.`,
    filePath,
  );
}

export function ioError(filePath: string, cause: unknown): FilesystemError {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new FilesystemError(
    FilesystemErrorCode.IO_ERROR,
    `I/O error on "${filePath}": ${msg}`,
    filePath,
  );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

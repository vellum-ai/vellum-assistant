// Normalized filesystem error codes and helper constructors.
// Provides a structured error model shared by sandbox and host filesystem tools.

export type FilesystemErrorCode =
  | 'INVALID_PATH'
  | 'PATH_OUT_OF_BOUNDS'
  | 'PATH_NOT_ABSOLUTE'
  | 'NOT_FOUND'
  | 'NOT_A_FILE'
  | 'SIZE_LIMIT_EXCEEDED'
  | 'MATCH_NOT_FOUND'
  | 'MATCH_AMBIGUOUS'
  | 'IO_ERROR';

export class FilesystemError extends Error {
  readonly code: FilesystemErrorCode;

  constructor(code: FilesystemErrorCode, message: string) {
    super(message);
    this.name = 'FilesystemError';
    this.code = code;
  }
}

// ── Helper constructors ─────────────────────────────────

export function invalidPath(path: string, reason?: string): FilesystemError {
  const detail = reason ? `: ${reason}` : '';
  return new FilesystemError('INVALID_PATH', `Invalid path "${path}"${detail}`);
}

export function pathOutOfBounds(path: string, boundary: string): FilesystemError {
  return new FilesystemError(
    'PATH_OUT_OF_BOUNDS',
    `Path "${path}" resolves outside the allowed boundary "${boundary}"`,
  );
}

export function pathNotAbsolute(path: string): FilesystemError {
  return new FilesystemError('PATH_NOT_ABSOLUTE', `Path must be absolute: ${path}`);
}

export function notFound(path: string): FilesystemError {
  return new FilesystemError('NOT_FOUND', `File not found: ${path}`);
}

export function notAFile(path: string): FilesystemError {
  return new FilesystemError('NOT_A_FILE', `Not a regular file: ${path}`);
}

export function sizeLimitExceeded(path: string, size: string, limit: string): FilesystemError {
  return new FilesystemError(
    'SIZE_LIMIT_EXCEEDED',
    `File size (${size}) exceeds the ${limit} limit: ${path}`,
  );
}

export function matchNotFound(path: string): FilesystemError {
  return new FilesystemError('MATCH_NOT_FOUND', `old_string not found in ${path}`);
}

export function matchAmbiguous(path: string, count: number): FilesystemError {
  return new FilesystemError(
    'MATCH_AMBIGUOUS',
    `old_string matches ${count} locations in ${path}. Provide more context to make it unique, or set replace_all to true.`,
  );
}

export function ioError(path: string, cause: string): FilesystemError {
  return new FilesystemError('IO_ERROR', `I/O error on "${path}": ${cause}`);
}

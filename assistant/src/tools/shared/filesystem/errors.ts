// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type FsErrorCode =
  | "INVALID_PATH"
  | "PATH_OUT_OF_BOUNDS"
  | "PATH_NOT_ABSOLUTE"
  | "NOT_FOUND"
  | "NOT_A_FILE"
  | "NOT_A_DIRECTORY"
  | "SIZE_LIMIT_EXCEEDED"
  | "MATCH_NOT_FOUND"
  | "MATCH_AMBIGUOUS"
  | "IO_ERROR";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export interface FsError {
  code: FsErrorCode;
  message: string;
  /** The path that caused the error, when applicable. */
  path?: string;
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function invalidPath(path: string, reason: string): FsError {
  return { code: "INVALID_PATH", message: reason, path };
}

export function pathOutOfBounds(path: string, boundary: string): FsError {
  return {
    code: "PATH_OUT_OF_BOUNDS",
    message: `Path "${path}" resolves outside the allowed boundary "${boundary}"`,
    path,
  };
}

export function pathNotAbsolute(path: string): FsError {
  return {
    code: "PATH_NOT_ABSOLUTE",
    message: `Path must be absolute: ${path}`,
    path,
  };
}

export function notFound(path: string): FsError {
  return { code: "NOT_FOUND", message: `File not found: ${path}`, path };
}

export function notAFile(path: string): FsError {
  return { code: "NOT_A_FILE", message: `Not a regular file: ${path}`, path };
}

export function notADirectory(path: string): FsError {
  return { code: "NOT_A_DIRECTORY", message: `Not a directory: ${path}`, path };
}

export function sizeLimitExceeded(path: string, detail: string): FsError {
  return {
    code: "SIZE_LIMIT_EXCEEDED",
    message: detail,
    path,
  };
}

export function matchNotFound(path: string): FsError {
  return {
    code: "MATCH_NOT_FOUND",
    message: `old_string not found in ${path}`,
    path,
  };
}

export function matchAmbiguous(path: string, count: number): FsError {
  return {
    code: "MATCH_AMBIGUOUS",
    message: `old_string appears ${count} times in ${path}. Provide more surrounding context to make it unique, or set replace_all to true.`,
    path,
  };
}

export function ioError(path: string, detail: string): FsError {
  return { code: "IO_ERROR", message: detail, path };
}

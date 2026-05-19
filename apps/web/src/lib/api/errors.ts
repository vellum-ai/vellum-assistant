// TODO: port from platform
export class ApiError extends Error {
  status?: number;
  body?: unknown;
}
export function extractErrorMessage(error: unknown, ..._rest: unknown[]): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

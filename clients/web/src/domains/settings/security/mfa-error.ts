/** Machine-readable `code` from a platform MFA error body, if present. */
export function mfaErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
}

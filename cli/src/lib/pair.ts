/**
 * Pure helpers for `vellum pair`'s remote-web approval flow.
 *
 * Pairing challenge stores are in-memory per gateway process, so approving a
 * code against a different assistant or environment than the one that served
 * the pair page looks identical to a typo'd or expired code. These helpers
 * turn the gateway's error envelope into a diagnostic that names the gateway
 * actually asked.
 */

/**
 * Extract the `error.code` from a gateway JSON error envelope
 * (`{"error":{"code":...,"message":...}}`). Returns null when the body is not
 * JSON or carries no string code.
 */
export function parseGatewayErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === "string" ? parsed.error.code : null;
  } catch {
    return null;
  }
}

/**
 * Diagnostic for a failed `--web-approve`, naming which gateway rejected the
 * code and hinting at cross-assistant / cross-environment mismatches. Returns
 * null for error codes this helper doesn't recognize, so the caller falls
 * back to the generic HTTP error text.
 */
export function formatWebApproveFailure(
  gatewayUrl: string,
  assistantName: string,
  envName: string,
  errorCode: string | null,
): string | null {
  if (errorCode !== "INVALID_USER_CODE" && errorCode !== "EXPIRED_USER_CODE") {
    return null;
  }
  const rejection =
    errorCode === "EXPIRED_USER_CODE"
      ? "Pairing code expired on"
      : "No such pairing code on";
  return [
    `${rejection} ${gatewayUrl} (assistant "${assistantName}", environment "${envName}").`,
    "Codes are minted by the gateway that serves the pair page, expire after 10 minutes, and are single-use.",
    "If the pair page came from a different assistant or environment (e.g. the desktop app's), re-run with that environment's VELLUM_ENVIRONMENT and that assistant's name.",
  ].join("\n");
}

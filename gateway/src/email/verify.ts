import { verifyVellumSignature } from "../http/vellum-signature.js";

/**
 * Verify the Vellum-Signature header sent by the Vellum platform.
 *
 * The scheme itself lives in `http/vellum-signature.ts`, shared with the
 * plugin webhook routes so one comparison serves both.
 */
export function verifyEmailWebhookSignature(
  headers: Headers,
  rawBody: string,
  webhookSecret: string,
): boolean {
  return verifyVellumSignature(headers, rawBody, webhookSecret);
}

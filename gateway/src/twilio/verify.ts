import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Validates a Twilio X-Twilio-Signature header using HMAC-SHA1.
 *
 * Algorithm (from Twilio docs):
 * 1. Take the full URL of the request.
 * 2. Sort the POST parameters alphabetically by key.
 * 3. Concatenate the URL with each key-value pair (key + value, no delimiters).
 * 4. HMAC-SHA1 the result using the auth token as the key.
 * 5. Base64-encode the hash.
 * 6. Compare to the X-Twilio-Signature header value.
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
  authToken: string,
): boolean {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const computed = createHmac("sha1", authToken)
    .update(data)
    .digest("base64");

  // Constant-time comparison to prevent timing attacks
  const a = Buffer.from(computed);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

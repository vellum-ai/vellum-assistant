/**
 * Decoding the base64 payloads that reach the app as strings.
 *
 * Two shapes arrive and mean the same thing. An attachment carries its bytes as
 * a full `data:` URI; the native camera bridge answers with the payload alone.
 * One decoder takes both, so a caller never has to know which it is holding and
 * the paths cannot drift on what counts as decodable.
 */

/**
 * Decode the base64 bytes out of `encoded`, or null when it carries none.
 *
 * A string beginning with `data:` is read as a URI, and yields bytes only from
 * a `;base64,` segment: a URI without one, or with nothing after it, carries
 * nothing to decode. Anything else is taken as the payload itself.
 *
 * Base64 that is present but malformed throws out of `atob` rather than
 * answering null, and callers depend on the difference: null is "there are no
 * bytes here, use the other path", which is the wrong thing to do with bytes
 * that are there and are broken.
 */
export function decodeBase64Payload(
  encoded: string,
): Uint8Array<ArrayBuffer> | null {
  const payload = encoded.startsWith("data:")
    ? (encoded.match(/;base64,(.*)$/)?.[1] ?? "")
    : encoded;
  if (!payload) {
    return null;
  }
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

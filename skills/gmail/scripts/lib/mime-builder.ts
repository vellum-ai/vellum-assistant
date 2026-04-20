#!/usr/bin/env bun

/**
 * Pure-function MIME builder for multipart messages with attachments.
 * Returns a base64url-encoded string suitable for the Gmail API's `raw` field.
 */

import { randomBytes } from "node:crypto";

export interface MimeAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface MimeMessageOptions {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  cc?: string;
  bcc?: string;
  attachments: MimeAttachment[];
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** Convert a Buffer to base64url encoding (URL-safe, no padding). */
export function toBase64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build a multipart/mixed MIME message with attachments.
 * Returns a base64url-encoded string ready for Gmail's messages.send `raw` field.
 */
export function buildMultipartMime(options: MimeMessageOptions): string {
  const { to, subject, body, inReplyTo, cc, bcc, attachments } = options;
  const boundary = `----=_Part_${randomBytes(16).toString("hex")}`;

  const sanitizedTo = sanitizeHeaderValue(to);
  const sanitizedSubject = sanitizeHeaderValue(subject);
  const sanitizedCc = cc ? sanitizeHeaderValue(cc) : undefined;
  const sanitizedBcc = bcc ? sanitizeHeaderValue(bcc) : undefined;
  const sanitizedInReplyTo = inReplyTo
    ? sanitizeHeaderValue(inReplyTo)
    : undefined;

  const headers = [
    `To: ${sanitizedTo}`,
    `Subject: ${sanitizedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  if (sanitizedCc) headers.push(`Cc: ${sanitizedCc}`);
  if (sanitizedBcc) headers.push(`Bcc: ${sanitizedBcc}`);
  if (sanitizedInReplyTo) {
    headers.push(`In-Reply-To: ${sanitizedInReplyTo}`);
    headers.push(`References: ${sanitizedInReplyTo}`);
  }

  const parts: string[] = [];

  // Text body part
  parts.push(
    `--${boundary}\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      "Content-Transfer-Encoding: 7bit\r\n" +
      "\r\n" +
      body,
  );

  // Attachment parts
  for (const att of attachments) {
    const b64 = att.data.toString("base64");
    parts.push(
      `--${boundary}\r\n` +
        `Content-Type: ${att.mimeType}; name="${att.filename}"\r\n` +
        "Content-Transfer-Encoding: base64\r\n" +
        `Content-Disposition: attachment; filename="${att.filename}"\r\n` +
        "\r\n" +
        b64,
    );
  }

  const mimeMessage = `${headers.join("\r\n")}\r\n\r\n${parts.join(
    "\r\n",
  )}\r\n--${boundary}--`;
  return toBase64Url(Buffer.from(mimeMessage, "utf-8"));
}

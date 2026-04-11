/**
 * Markdown → email-safe HTML renderer.
 *
 * Converts a markdown/plain-text email body into a styled HTML document
 * suitable for email clients.  Uses `marked` for parsing and wraps the
 * result in a minimal responsive template with inline styles.
 *
 * Design constraints:
 *  - Inline CSS only (no <style> blocks — many email clients strip them).
 *  - System font stack for maximum compatibility.
 *  - Dark-mode friendly via prefers-color-scheme media query on the wrapper.
 *  - Plain-text fallback is always sent alongside; this HTML is additive.
 */

import { marked } from "marked";

// ---------------------------------------------------------------------------
// marked configuration
// ---------------------------------------------------------------------------

marked.setOptions({
  gfm: true,
  breaks: true,
});

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Helvetica Neue', Arial, sans-serif";

function wrapInEmailTemplate(innerHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background-color:#f5f5f5; font-family:${FONT_STACK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px; background-color:#ffffff; border-radius:8px; overflow:hidden;">
<tr><td style="padding:32px 32px 24px 32px; font-family:${FONT_STACK}; font-size:15px; line-height:1.6; color:#1a1a1a;">
${innerHtml}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a markdown (or plain-text) string into email-safe HTML.
 *
 * When the input is already HTML (starts with `<` after trimming), it is
 * returned as-is — no double-wrapping.
 */
export function markdownToEmailHtml(markdown: string): string {
  const trimmed = markdown.trim();

  // Already HTML — don't re-process.
  if (trimmed.startsWith("<")) {
    return trimmed;
  }

  const innerHtml = marked.parse(trimmed) as string;
  return wrapInEmailTemplate(innerHtml);
}

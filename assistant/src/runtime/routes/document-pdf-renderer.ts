/**
 * Markdown to PDF renderer for document export.
 *
 * Converts markdown content to styled HTML via `marked`, then renders
 * the HTML to a PDF buffer using Playwright headless Chromium.
 * The HTML template uses print-friendly styling that matches the
 * document editor typography.
 */

import { marked } from "marked";

import { importPlaywright } from "../../tools/browser/runtime-check.js";

// ---------------------------------------------------------------------------
// Print template
// ---------------------------------------------------------------------------

const FONT_STACK = `"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;

function wrapInPrintTemplate(title: string, innerHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: ${FONT_STACK};
    font-size: 14px;
    line-height: 1.7;
    color: #1a1a1a;
    background: #ffffff;
    padding: 0;
  }

  h1 { font-size: 28px; font-weight: 600; margin-top: 32px; margin-bottom: 12px; }
  h2 { font-size: 22px; font-weight: 600; margin-top: 28px; margin-bottom: 10px; }
  h3 { font-size: 18px; font-weight: 600; margin-top: 24px; margin-bottom: 8px; }
  h4, h5, h6 { font-size: 16px; font-weight: 600; margin-top: 20px; margin-bottom: 8px; }

  p {
    margin-bottom: 12px;
  }

  pre {
    background: #f5f5f5;
    border-radius: 8px;
    padding: 12px 16px;
    overflow-x: auto;
    margin-bottom: 12px;
  }

  code {
    font-family: "DM Mono", "SF Mono", monospace;
    font-size: 13px;
    background: #f5f5f5;
    border-radius: 4px;
    padding: 2px 5px;
  }

  pre code {
    background: none;
    padding: 0;
    border-radius: 0;
  }

  blockquote {
    border-left: 3px solid #6366f1;
    padding-left: 16px;
    margin: 12px 0;
    color: #555555;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
  }

  th, td {
    border: 1px solid #e0e0e0;
    padding: 8px 12px;
    text-align: left;
  }

  th {
    background: #f5f5f5;
    font-weight: 600;
  }

  ul, ol {
    margin: 12px 0;
    padding-left: 24px;
  }

  li {
    margin-bottom: 4px;
  }

  a {
    color: #6366f1;
    text-decoration: none;
  }

  hr {
    border: none;
    border-top: 1px solid #e0e0e0;
    margin: 24px 0;
  }

  img {
    max-width: 100%;
    height: auto;
  }

  .document-title {
    margin-top: 0;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid #e0e0e0;
  }
</style>
</head>
<body>
<h1 class="document-title">${escapeHtml(title)}</h1>
${innerHtml}
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a markdown string to a PDF buffer.
 *
 * Parses markdown to HTML via `marked`, wraps it in a print-friendly
 * template, then renders to PDF using Playwright headless Chromium.
 * The browser is always closed in a `finally` block.
 */
export async function renderMarkdownToPDF(
  title: string,
  markdown: string,
): Promise<Buffer> {
  const innerHtml = marked.parse(markdown, {
    gfm: true,
    breaks: true,
  }) as string;
  const fullHtml = wrapInPrintTemplate(title, innerHtml);

  const pw = await importPlaywright();
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(fullHtml, { waitUntil: "networkidle" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      margin: {
        top: "0.75in",
        bottom: "0.75in",
        left: "0.75in",
        right: "0.75in",
      },
      printBackground: true,
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}

/**
 * Markdown to PDF renderer for document export.
 *
 * Converts markdown content to styled HTML via `marked`, then renders
 * the HTML to a PDF buffer using installed headless Chrome.
 * The HTML template uses print-friendly styling that matches the
 * document editor typography.
 */

import { marked } from "marked";

import { withPdfChrome } from "./pdf-chrome.js";

// ---------------------------------------------------------------------------
// Print template
// ---------------------------------------------------------------------------

const FONT_STACK = `"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;

function wrapInPrintTemplate(innerHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
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

</style>
</head>
<body>
${innerHtml}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a markdown string to a PDF buffer.
 *
 * Parses markdown to HTML via `marked`, wraps it in a print-friendly
 * template, then renders to PDF using installed headless Chrome.
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
  const fullHtml = wrapInPrintTemplate(innerHtml);

  return withPdfChrome(async (transport, signal) => {
    const { targetId } = await transport.send<{ targetId: string }>(
      "Target.createTarget",
      { url: "about:blank" },
      { signal },
    );
    const { sessionId } = await transport.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
      { signal },
    );
    const options = { sessionId, signal };
    await transport.send(
      "Emulation.setScriptExecutionDisabled",
      { value: true },
      options,
    );
    await transport.send("Network.enable", {}, options);
    await transport.send("Network.setBlockedURLs", { urls: ["*"] }, options);
    const { frameTree } = await transport.send<{
      frameTree: { frame: { id: string } };
    }>("Page.getFrameTree", {}, options);
    await transport.send(
      "Page.setDocumentContent",
      {
        frameId: frameTree.frame.id,
        html: fullHtml,
      },
      options,
    );
    const { data } = await transport.send<{ data: string }>(
      "Page.printToPDF",
      {
        paperWidth: 8.2677165354,
        paperHeight: 11.6929133858,
        marginTop: 0.75,
        marginBottom: 0.75,
        marginLeft: 0.75,
        marginRight: 0.75,
        printBackground: true,
      },
      options,
    );
    return Buffer.from(data, "base64");
  });
}

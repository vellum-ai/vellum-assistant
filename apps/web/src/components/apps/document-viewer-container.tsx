import { ChevronDown, Download, FileText, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button, Menu, Typography } from "@vellum/design-library";
import { documentsByIdPdfGet } from "@/generated/daemon/sdk.gen";

export interface DocumentViewerContainerProps {
  documentName: string;
  content: string;
  onClose: () => void;
  assistantId?: string;
  surfaceId?: string;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

function sanitizeFilename(title: string): string {
  const replaced = title.replace(/ /g, "-");
  const sanitized = replaced.replace(/[^a-zA-Z0-9_-]/g, "");
  return sanitized || "document";
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function generateEditorHTML(title: string, initialContent: string, isDark: boolean): string {
  const escapedTitle = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapedTitle}</title>
  <link rel="stylesheet" href="https://uicdn.toast.com/editor/latest/toastui-editor.min.css" />
  <style>
    :root {
      --v-bg: ${isDark ? "#20201E" : "#FFFFFF"};
      --v-surface: ${isDark ? "#3A3A37" : "#F5F5F7"};
      --v-surface-border: ${isDark ? "#4A4A46" : "#D2D2D7"};
      --v-text: ${isDark ? "#F5F3EB" : "#1D1D1F"};
      --v-text-secondary: ${isDark ? "#A1A096" : "#86868B"};
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
      background: var(--v-bg);
      color: var(--v-text);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .editor-container { flex: 1; overflow: hidden; }
    #editor { height: 100%; }
    .toastui-editor-defaultUI { border: none !important; }
    .toastui-editor-toolbar {
      background: var(--v-surface) !important;
      border-bottom: 1px solid var(--v-surface-border) !important;
    }
    .toastui-editor-toolbar-icons { color: var(--v-text-secondary) !important; }
    .toastui-editor-toolbar-icons:hover { background-color: var(--v-surface-border) !important; }
    .toastui-editor-md-container,
    .toastui-editor-ww-container { background: var(--v-bg) !important; color: var(--v-text) !important; }
    .toastui-editor-contents { color: var(--v-text) !important; }
    .toastui-editor-contents h1,
    .toastui-editor-contents h2,
    .toastui-editor-contents h3 { color: var(--v-text) !important; border-bottom-color: var(--v-surface-border) !important; }
    .toastui-editor-contents pre { background: var(--v-surface) !important; }
    .toastui-editor-contents code { background: var(--v-surface) !important; color: var(--v-text) !important; }
    .toastui-editor-contents blockquote { border-left-color: #657D5B !important; color: var(--v-text-secondary) !important; }
    .toastui-editor-contents table td,
    .toastui-editor-contents table th { border-color: var(--v-surface-border) !important; }
    .toastui-editor-mode-switch { display: none !important; }
  </style>
</head>
<body>
  <div class="editor-container">
    <div id="editor"></div>
  </div>
  <script src="https://uicdn.toast.com/editor/latest/toastui-editor-all.min.js"><\/script>
  <script>
    var isDark = ${isDark ? "true" : "false"};
    if (isDark) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://uicdn.toast.com/editor/latest/theme/toastui-editor-dark.min.css';
      document.head.appendChild(link);
    }
    const editor = new toastui.Editor({
      el: document.querySelector('#editor'),
      height: '100%',
      initialEditType: 'wysiwyg',
      previewStyle: 'vertical',
      theme: isDark ? 'dark' : 'light',
      usageStatistics: false,
      initialValue: ${JSON.stringify(initialContent)},
      toolbarItems: [
        ['heading', 'bold', 'italic', 'strike'],
        ['hr', 'quote'],
        ['ul', 'ol', 'task', 'indent', 'outdent'],
        ['table', 'link', 'code', 'codeblock']
      ],
    });
    editor.on('change', function() {
      const content = editor.getMarkdown();
      const wordCount = content.trim().split(/\\s+/).filter(function(w) { return w.length > 0; }).length;
      window.parent.postMessage({ type: 'document_content_changed', content: content, wordCount: wordCount }, '*');
    });
    window.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'set_content') {
        editor.setMarkdown(event.data.content || '', false);
      }
    });
    setTimeout(function() { editor.focus(); }, 100);
  <\/script>
</body>
</html>`;
}

export function DocumentViewerContainer({
  documentName,
  content,
  onClose,
  assistantId,
  surfaceId,
}: DocumentViewerContainerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const currentContentRef = useRef<string>(content);
  const [wordCount, setWordCount] = useState(() => countWords(content));
  const [isExportingPDF, setIsExportingPDF] = useState(false);

  const theme = typeof document !== "undefined" ? document.documentElement.dataset.theme : undefined;
  const isDark = theme === "dark" || theme === "velvet";

  const srcdoc = useMemo(
    () => generateEditorHTML(documentName, content, isDark),
    [documentName, content, isDark],
  );

  const handleMessage = useCallback((event: MessageEvent) => {
    if (event.data?.type === "document_content_changed") {
      const newContent = event.data.content as string;
      const newWordCount = event.data.wordCount as number;
      currentContentRef.current = newContent;
      setWordCount(newWordCount);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  const handleExportMarkdown = useCallback(() => {
    const markdown = currentContentRef.current;
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    downloadBlob(blob, sanitizeFilename(documentName) + ".md");
  }, [documentName]);

  const handleExportPDF = useCallback(async () => {
    if (!assistantId || !surfaceId) {
      return;
    }
    setIsExportingPDF(true);
    try {
      const { response: pdfResponse } = await documentsByIdPdfGet({
        path: { assistant_id: assistantId, id: surfaceId },
        throwOnError: false,
        parseAs: "stream",
      });
      if (pdfResponse && pdfResponse.ok) {
        const pdfBlob = await pdfResponse.blob();
        downloadBlob(pdfBlob, sanitizeFilename(documentName) + ".pdf");
      }
    } finally {
      setIsExportingPDF(false);
    }
  }, [assistantId, surfaceId, documentName]);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl bg-[var(--surface-lift)]">
      {/* Nav bar */}
      <div className="flex items-center justify-between rounded-t-xl bg-[var(--surface-base)] px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="h-4 w-4 shrink-0 text-[var(--content-tertiary)]" />
          <Typography
            variant="body-large-default"
            className="truncate text-[var(--content-emphasised)]"
            style={{ lineHeight: 1.4 }}
          >
            {documentName}
          </Typography>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {wordCount > 0 && (
            <Typography
              variant="label-small-default"
              className="rounded-md bg-[var(--surface-lift)] px-2 py-0.5 text-[var(--content-tertiary)]"
            >
              {wordCount} words
            </Typography>
          )}

          <div className="flex items-center">
            <Button
              variant="ghost"
              size="compact"
              leftIcon={<Download className="h-3.5 w-3.5" />}
              rightIcon={null}
              onClick={handleExportMarkdown}
              className="rounded-r-none border-r-0"
            >
              Export
            </Button>
            <Menu.Root>
              <Menu.Trigger>
                <Button
                  variant="ghost"
                  size="compact"
                  iconOnly={
                    isExportingPDF
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <ChevronDown className="h-3 w-3" />
                  }
                  className="rounded-l-none"
                  disabled={isExportingPDF}
                />
              </Menu.Trigger>
              <Menu.Content align="end">
                <Menu.Item
                  onSelect={handleExportPDF}
                  disabled={!assistantId || !surfaceId || isExportingPDF}
                >
                  {isExportingPDF ? "Exporting…" : "Export as PDF"}
                </Menu.Item>
              </Menu.Content>
            </Menu.Root>
          </div>

          <Button variant="outlined" iconOnly={<X />} onClick={onClose} tooltip="Close" />
        </div>
      </div>

      {/* Document editor */}
      <div className="relative min-h-0 flex-1">
        <iframe
          ref={iframeRef}
          srcDoc={srcdoc}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          title={documentName}
          className="h-full w-full border-none"
        />
      </div>
    </div>
  );
}

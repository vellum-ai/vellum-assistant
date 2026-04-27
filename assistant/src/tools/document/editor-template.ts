/**
 * Generates the Toast UI Editor HTML template for document editing.
 *
 * Features:
 * - WYSIWYG and Markdown source modes
 * - Dark theme matching Vellum design
 * - Real-time word count
 * - Auto-save via Vellum JS bridge
 * - Code syntax highlighting
 * - Tables, task lists, and rich formatting
 */

export function generateEditorHTML(
  title: string,
  initialContent: string,
): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>

  <!-- Toast UI Editor CSS -->
  <link rel="stylesheet" href="https://uicdn.toast.com/editor/latest/toastui-editor.min.css" />
  <link rel="stylesheet" href="https://uicdn.toast.com/editor/latest/theme/toastui-editor-dark.min.css"
        media="(prefers-color-scheme: dark)" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css"
        media="(prefers-color-scheme: dark)" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css"
        media="(prefers-color-scheme: light)" />

  <style>
    :root {
      --v-bg: #FFFFFF;
      --v-surface: #F5F5F7;
      --v-surface-border: #D2D2D7;
      --v-text: #1D1D1F;
      --v-text-secondary: #86868B;
      --v-text-muted: #AEAEB2;
      --v-accent: #657D5B;
      --v-accent-hover: #516748;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --v-bg: #20201E;
        --v-surface: #3A3A37;
        --v-surface-border: #4A4A46;
        --v-text: #F5F3EB;
        --v-text-secondary: #A1A096;
        --v-text-muted: #6B6B65;
        --v-accent: #657D5B;
        --v-accent-hover: #516748;
      }
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

    .header { display: none; }

    .title-input {
      font-size: 20px;
      font-weight: 600;
      background: transparent;
      border: none;
      color: var(--v-text);
      outline: none;
      flex: 1;
      min-width: 0;
    }

    .title-input::placeholder { color: var(--v-text-muted); }

    .status {
      font-size: 12px;
      color: var(--v-text-secondary);
      margin-left: 16px;
      white-space: nowrap;
    }

    .editor-container {
      flex: 1;
      overflow: hidden;
    }

    #editor {
      height: 100%;
    }

    /* Override Toast UI Editor theme colors to match Vellum */
    .toastui-editor-defaultUI { border: none !important; }
    .toastui-editor-toolbar { background: var(--v-surface) !important; border-bottom: 1px solid var(--v-surface-border) !important; }
    .toastui-editor-toolbar-icons { color: var(--v-text-secondary) !important; }
    .toastui-editor-toolbar-icons:hover { background: var(--v-surface-border) !important; }
    .toastui-editor-md-container,
    .toastui-editor-ww-container { background: var(--v-bg) !important; color: var(--v-text) !important; }
    .toastui-editor-contents { color: var(--v-text) !important; padding: 0 !important; }
    .toastui-editor-ww-content { padding: 0 !important; }
    .ProseMirror { padding: 0 !important; }
    .toastui-editor-md-container .toastui-editor { padding: 0 !important; }
    .toastui-editor-contents h1,
    .toastui-editor-contents h2,
    .toastui-editor-contents h3 { color: var(--v-text) !important; border-bottom-color: var(--v-surface-border) !important; }
    .toastui-editor-contents pre { background: var(--v-surface) !important; }
    .toastui-editor-contents code { background: var(--v-surface) !important; color: var(--v-text) !important; }
    .toastui-editor-contents blockquote { border-left-color: var(--v-accent) !important; color: var(--v-text-secondary) !important; }
    .toastui-editor-contents table td,
    .toastui-editor-contents table th { border-color: var(--v-surface-border) !important; }
  </style>
</head>
<body>
  <div class="header">
    <input type="text" class="title-input" placeholder="Untitled Document" value="${escapeHtml(
      title,
    )}" id="title-input" />
    <div class="status" id="status">Ready</div>
  </div>

  <div class="editor-container">
    <div id="editor"></div>
  </div>

  <!-- Toast UI Editor JS -->
  <script src="https://uicdn.toast.com/editor/latest/toastui-editor-all.min.js"></script>

  <script>
    // Initialize Toast UI Editor
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    const editor = new toastui.Editor({
      el: document.querySelector('#editor'),
      height: '100%',
      initialEditType: 'wysiwyg',
      previewStyle: 'vertical',
      theme: prefersDark ? 'dark' : 'light',
      usageStatistics: false,
      initialValue: ${JSON.stringify(initialContent)},
      toolbarItems: [
        ['heading', 'bold', 'italic', 'strike'],
        ['hr', 'quote'],
        ['ul', 'ol', 'task', 'indent', 'outdent'],
        ['table', 'link', 'image', 'code', 'codeblock']
      ],
      hooks: {
        addImageBlobHook: (blob, callback) => {
          // Convert image to base64 and insert
          const reader = new FileReader();
          reader.onload = (e) => callback(e.target.result, blob.name);
          reader.readAsDataURL(blob);
        }
      }
    });

    const titleInput = document.getElementById('title-input');
    const statusEl = document.getElementById('status');
    let wordCount = 0;
    let saveTimeout = null;

    // Update word count
    function updateWordCount() {
      const text = editor.getMarkdown();
      wordCount = text.trim().split(/\\s+/).filter(w => w.length > 0).length;
      statusEl.textContent = \`\${wordCount} words\`;
    }

    // Notify daemon of content changes (debounced)
    function notifyContentChanged() {
      clearTimeout(saveTimeout);
      statusEl.textContent = 'Saving...';

      saveTimeout = setTimeout(() => {
        const content = editor.getMarkdown();
        const title = titleInput.value.trim() || 'Untitled Document';

        if (typeof window.vellum !== 'undefined' && typeof window.vellum.sendAction === 'function') {
          window.vellum.sendAction('content_changed', {
            title,
            content,
            wordCount
          });
        }

        updateWordCount();
      }, 500);
    }

    // Listen for content changes
    editor.on('change', notifyContentChanged);
    titleInput.addEventListener('input', notifyContentChanged);

    // Vellum bridge: handle content updates from daemon
    if (typeof window.vellum !== 'undefined') {
      window.vellum.onContentUpdate = function(data) {
        if (data.markdown) {
          const mode = data.updateMode || 'append';
          const currentContent = editor.getMarkdown();

          if (mode === 'replace') {
            editor.setMarkdown(data.markdown, false);
          } else if (mode === 'append') {
            editor.setMarkdown(currentContent + '\\n\\n' + data.markdown, false);
            // Scroll to bottom
            editor.moveCursorToEnd();
          }

          updateWordCount();
        }

        if (data.title) {
          titleInput.value = data.title;
        }
      };
    }

    // Initial word count
    updateWordCount();

    // Focus editor
    setTimeout(() => editor.focus(), 100);
  </script>
</body>
</html>
  `.trim();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

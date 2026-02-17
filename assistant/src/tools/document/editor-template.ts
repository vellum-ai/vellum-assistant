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

export function generateEditorHTML(title: string, initialContent: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>

  <!-- Toast UI Editor CSS -->
  <link rel="stylesheet" href="https://uicdn.toast.com/editor/latest/toastui-editor.min.css" />
  <link rel="stylesheet" href="https://uicdn.toast.com/editor/latest/theme/toastui-editor-dark.min.css" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css" />

  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
      background: #0f172a;
      color: #f8fafc;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .header {
      padding: 16px 24px;
      border-bottom: 1px solid #334155;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }

    .title-input {
      font-size: 20px;
      font-weight: 600;
      background: transparent;
      border: none;
      color: #f8fafc;
      outline: none;
      flex: 1;
      min-width: 0;
    }

    .title-input::placeholder { color: #64748b; }

    .status {
      font-size: 12px;
      color: #94a3b8;
      margin-left: 16px;
      white-space: nowrap;
    }

    .editor-container {
      flex: 1;
      overflow: hidden;
      padding: 24px;
    }

    #editor {
      height: 100%;
    }

    /* Override Toast UI Editor dark theme colors to match Vellum */
    .toastui-editor-defaultUI { border: none !important; }
    .toastui-editor-toolbar { background: #1e293b !important; border-bottom: 1px solid #334155 !important; }
    .toastui-editor-toolbar-icons { color: #cbd5e1 !important; }
    .toastui-editor-toolbar-icons:hover { background: #334155 !important; }
    .toastui-editor-md-container,
    .toastui-editor-ww-container { background: #0f172a !important; color: #f8fafc !important; }
    .toastui-editor-contents { color: #f8fafc !important; }
    .toastui-editor-contents h1,
    .toastui-editor-contents h2,
    .toastui-editor-contents h3 { color: #f8fafc !important; border-bottom-color: #334155 !important; }
    .toastui-editor-contents pre { background: #1e293b !important; }
    .toastui-editor-contents code { background: #1e293b !important; color: #e2e8f0 !important; }
    .toastui-editor-contents blockquote { border-left-color: #7c3aed !important; color: #cbd5e1 !important; }
    .toastui-editor-contents table td,
    .toastui-editor-contents table th { border-color: #334155 !important; }
  </style>
</head>
<body>
  <div class="header">
    <input type="text" class="title-input" placeholder="Untitled Document" value="${escapeHtml(title)}" id="title-input" />
    <div class="status" id="status">Ready</div>
  </div>

  <div class="editor-container">
    <div id="editor"></div>
  </div>

  <!-- Toast UI Editor JS -->
  <script src="https://uicdn.toast.com/editor/latest/toastui-editor-all.min.js"></script>

  <script>
    // Initialize Toast UI Editor
    const editor = new toastui.Editor({
      el: document.querySelector('#editor'),
      height: '100%',
      initialEditType: 'wysiwyg',
      previewStyle: 'vertical',
      theme: 'dark',
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

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

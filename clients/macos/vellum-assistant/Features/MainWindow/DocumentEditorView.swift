import SwiftUI
import WebKit
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "DocumentEditor")

/// Built-in document editor view using Toast UI Editor.
/// Displayed in the Directory panel's Documents tab.
struct DocumentEditorView: NSViewRepresentable {
    var documentManager: DocumentManager
    let onContentChanged: (String, String, Int) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(documentManager: documentManager, onContentChanged: onContentChanged)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        let contentController = WKUserContentController()

        // Inject Vellum bridge for content change notifications
        let bridgeScript = WKUserScript(
            source: """
                window.vellum = {
                    sendAction: function(actionId, data) {
                        window.webkit.messageHandlers.vellumBridge.postMessage({actionId: actionId, data: data});
                    }
                };
                """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        contentController.addUserScript(bridgeScript)
        contentController.add(context.coordinator, name: "vellumBridge")

        configuration.userContentController = contentController

        #if DEBUG
        let webInspectorKey = ["developer", "Extras", "Enabled"].joined()
        configuration.preferences.setValue(true, forKey: webInspectorKey)
        #endif

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView

        // Load document content first (existing doc or empty placeholder).
        // contentForEditorView() also clears pendingInitialContent so the coordinator
        // didSet won't trigger a redundant second loadHTMLString.
        if let doc = documentManager.contentForEditorView() {
            loadEditorHTML(webView: webView, title: doc.title, content: doc.content)
        } else {
            loadEditorHTML(webView: webView, title: "Untitled Document", content: "")
        }

        // Register coordinator with DocumentManager (after loading so no double-load)
        documentManager.editorCoordinator = context.coordinator

        log.info("DocumentEditorView created")
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // No updates needed - content updates are handled via coordinator
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "vellumBridge")
    }

    private func loadEditorHTML(webView: WKWebView, title: String, content: String) {
        let html = generateEditorHTML(title: title, initialContent: content)
        webView.loadHTMLString(html, baseURL: URL(string: "https://document.vellum.local/"))
    }

    // MARK: - Coordinator

    class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, DocumentEditorCoordinator {
        let documentManager: DocumentManager
        let onContentChanged: (String, String, Int) -> Void
        weak var webView: WKWebView?
        private var isInitialized = false

        init(documentManager: DocumentManager, onContentChanged: @escaping (String, String, Int) -> Void) {
            self.documentManager = documentManager
            self.onContentChanged = onContentChanged
        }

        // MARK: - DocumentEditorCoordinator

        func setInitialContent(title: String, markdown: String) {
            guard let webView = webView else { return }

            // If already initialized, just update content
            if isInitialized {
                let escapedTitle = escapeForJS(title)
                let escapedMarkdown = escapeForJS(markdown)
                let js = """
                    (function() {
                        if (typeof window.editor !== 'undefined') {
                            window.editor.setMarkdown('\(escapedMarkdown)', false);
                            document.getElementById('title-input').value = '\(escapedTitle)';
                        }
                    })();
                    """
                webView.evaluateJavaScript(js) { _, error in
                    if let error = error {
                        log.error("setInitialContent JS error: \(error.localizedDescription)")
                    } else {
                        log.info("Initial content set: title=\(title), length=\(markdown.count)")
                    }
                }
            } else {
                // Editor not ready yet, reload with new content
                let html = generateEditorHTML(title: title, initialContent: markdown)
                webView.loadHTMLString(html, baseURL: URL(string: "https://document.vellum.local/"))
            }
        }

        func sendContentUpdate(markdown: String, mode: String) {
            guard let webView = webView, isInitialized else {
                log.warning("Cannot send content update: editor not initialized (isInitialized=\(self.isInitialized))")
                return
            }

            let escapedMarkdown = escapeForJS(markdown)
            let js: String

            if mode == "replace" {
                js = """
                    (function() {
                        if (typeof window.editor !== 'undefined') {
                            window.editor.setMarkdown('\(escapedMarkdown)', false);
                        }
                    })();
                    """
            } else {
                // append mode
                js = """
                    (function() {
                        if (typeof window.editor !== 'undefined') {
                            var current = window.editor.getMarkdown();
                            window.editor.setMarkdown(current + '\\n\\n' + '\(escapedMarkdown)', false);
                            window.editor.moveCursorToEnd();
                        }
                    })();
                    """
            }

            webView.evaluateJavaScript(js) { _, error in
                if let error = error {
                    log.error("sendContentUpdate JS error: \(error.localizedDescription)")
                } else {
                    log.info("Content update sent: mode=\(mode), length=\(markdown.count)")
                }
            }
        }

        // MARK: - WKScriptMessageHandler

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  let actionId = body["actionId"] as? String else { return }

            if actionId == "content_changed", let data = body["data"] as? [String: Any] {
                let title = data["title"] as? String ?? "Untitled Document"
                let content = data["content"] as? String ?? ""
                let wordCount = data["wordCount"] as? Int ?? 0
                onContentChanged(title, content, wordCount)
            }
        }

        // MARK: - WKNavigationDelegate

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            isInitialized = true
            log.info("Document editor loaded")
            // Apply any content that accumulated while the WebView was loading
            // (document_editor_update messages that arrived before isInitialized was set)
            if let tracked = documentManager.currentContent, !tracked.isEmpty {
                setInitialContent(title: documentManager.title, markdown: tracked)
            }
        }

        private func escapeForJS(_ str: String) -> String {
            return str
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
                .replacingOccurrences(of: "\n", with: "\\n")
                .replacingOccurrences(of: "\r", with: "\\r")
        }
    }
}

// MARK: - HTML Generation

/// Loads a bundled editor asset from Resources/editor/ as a String.
/// Falls back to an empty string if the file cannot be read.
private func loadEditorAsset(_ filename: String) -> String {
    let name = (filename as NSString).deletingPathExtension
    let ext = (filename as NSString).pathExtension
    guard let url = ResourceBundle.bundle.url(forResource: name, withExtension: ext, subdirectory: "editor"),
          let contents = try? String(contentsOf: url, encoding: .utf8) else {
        log.error("Failed to load bundled editor asset: \(filename)")
        return ""
    }
    return contents
}

/// Generates the Toast UI Editor HTML template.
/// Reuses the same editor from document-tool.ts editor-template.ts
private func generateEditorHTML(title: String, initialContent: String) -> String {
    let escapedTitle = escapeHTML(title)
    let escapedContent = escapeJSON(initialContent)

    // Load bundled editor assets
    let editorCSS = loadEditorAsset("toastui-editor.min.css")
    let editorDarkCSS = loadEditorAsset("toastui-editor-dark.min.css")
    let githubDarkCSS = loadEditorAsset("github-dark.min.css")
    let githubCSS = loadEditorAsset("github.min.css")
    let editorJS = loadEditorAsset("toastui-editor-all.min.js")

    return """
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>\(escapedTitle)</title>

  <!-- Toast UI Editor CSS (bundled) -->
  <style>\(editorCSS)</style>
  <style media="(prefers-color-scheme: dark)">\(editorDarkCSS)</style>
  <style media="(prefers-color-scheme: dark)">\(githubDarkCSS)</style>
  <style media="(prefers-color-scheme: light)">\(githubCSS)</style>

  <style>
    \(WebTokenInjector.editorCSSTokenBlock())
    /* Invert toolbar icons in dark mode — target both the JS-applied class and the media query */
    .toastui-editor-dark .toastui-editor-toolbar-icons { filter: invert(1) brightness(0.85) !important; }
    @media (prefers-color-scheme: dark) {
      .toastui-editor-toolbar-icons { filter: invert(1) brightness(0.85) !important; }
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: "DM Sans", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
      background: var(--v-bg);
      color: var(--v-text);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .header { display: none; }

    .title-input {
      font-family: "DM Sans", -apple-system, BlinkMacSystemFont, sans-serif;
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
    .toastui-editor-defaultUI { border: none !important; background: var(--v-bg) !important; }
    .toastui-editor-defaultUI-toolbar { background: var(--v-surface) !important; border-bottom: 1px solid var(--v-surface-border) !important; }
    .toastui-editor-toolbar { background: var(--v-surface) !important; border-top: 1px solid var(--v-surface-border) !important; border-bottom: 1px solid var(--v-surface-border) !important; }
    .toastui-editor-toolbar-icons { color: var(--v-text) !important; background-color: transparent !important; border: none !important; }
    .toastui-editor-toolbar-icons:hover { background-color: var(--v-surface-border) !important; }
    .toastui-editor-toolbar-icons.active { background-color: var(--v-surface-border) !important; }
    .toastui-editor-toolbar-divider { background: var(--v-surface-border) !important; }
    .toastui-editor-toolbar-group { border-right-color: var(--v-surface-border) !important; }
    .toastui-editor-popup { background: var(--v-surface) !important; border-color: var(--v-surface-border) !important; }
    .toastui-editor-popup-body { background: var(--v-surface) !important; }
    .toastui-editor-md-container,
    .toastui-editor-ww-container { background: var(--v-bg) !important; color: var(--v-text) !important; }
    .toastui-editor-contents { color: var(--v-text) !important; font-family: "DM Sans", -apple-system, BlinkMacSystemFont, sans-serif !important; font-size: 14px !important; line-height: 1.7 !important; padding: 24px 32px !important; }
    .toastui-editor-ww-content { padding: 24px 32px !important; }
    .ProseMirror { padding: 24px 32px !important; }
    .toastui-editor-md-container .toastui-editor { padding: 24px 32px !important; }
    .toastui-editor-contents h1 { font-family: "DM Sans", -apple-system, BlinkMacSystemFont, sans-serif !important; font-size: 28px !important; font-weight: 600 !important; color: var(--v-text) !important; border-bottom: none !important; margin-top: 32px !important; margin-bottom: 12px !important; }
    .toastui-editor-contents h2 { font-family: "DM Sans", -apple-system, BlinkMacSystemFont, sans-serif !important; font-size: 22px !important; font-weight: 600 !important; color: var(--v-text) !important; border-bottom: none !important; margin-top: 28px !important; margin-bottom: 10px !important; }
    .toastui-editor-contents h3 { font-family: "DM Sans", -apple-system, BlinkMacSystemFont, sans-serif !important; font-size: 18px !important; font-weight: 600 !important; color: var(--v-text) !important; border-bottom: none !important; margin-top: 24px !important; margin-bottom: 8px !important; }
    .toastui-editor-contents p { margin-bottom: 12px !important; }
    .toastui-editor-contents pre { background: var(--v-surface) !important; border-radius: 8px !important; padding: 12px 16px !important; }
    .toastui-editor-contents code { background: var(--v-surface) !important; color: var(--v-text) !important; font-family: "DMMono-Regular", "SF Mono", monospace !important; border-radius: 4px !important; padding: 2px 5px !important; font-size: 13px !important; }
    .toastui-editor-contents blockquote { border-left-color: var(--v-accent) !important; color: var(--v-text-secondary) !important; }
    .toastui-editor-contents table td,
    .toastui-editor-contents table th { border-color: var(--v-surface-border) !important; }
    /* Hide mode switch (Markdown / WYSIWYG toggle) */
    .toastui-editor-mode-switch { display: none !important; }
    /* Scrollbar styling */
    .toastui-editor-contents::-webkit-scrollbar { width: 6px; }
    .toastui-editor-contents::-webkit-scrollbar-track { background: transparent; }
    .toastui-editor-contents::-webkit-scrollbar-thumb { background: var(--v-surface-border); border-radius: 3px; }
  </style>
</head>
<body>
  <div class="header">
    <input type="text" class="title-input" placeholder="Untitled Document" value="\(escapedTitle)" id="title-input" />
    <div class="status" id="status">Ready</div>
  </div>

  <div class="editor-container">
    <div id="editor"></div>
  </div>

  <!-- Toast UI Editor JS (bundled) -->
  <script>\(editorJS)</script>

  <script>
    try {
      if (typeof toastui === 'undefined' || typeof toastui.Editor === 'undefined') {
        throw new Error('Toast UI Editor failed to load. Please check your network connection and try again.');
      }

      // Initialize Toast UI Editor
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

      window.editor = new toastui.Editor({
        el: document.querySelector('#editor'),
        height: '100%',
        initialEditType: 'wysiwyg',
        previewStyle: 'vertical',
        theme: prefersDark ? 'dark' : 'light',
        usageStatistics: false,
        initialValue: \(escapedContent),
        toolbarItems: [
          ['heading', 'bold', 'italic', 'strike'],
          ['hr', 'quote'],
          ['ul', 'ol', 'task', 'indent', 'outdent'],
          ['table', 'link', 'image', 'code', 'codeblock']
        ],
        hooks: {
          addImageBlobHook: (blob, callback) => {
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
        const text = window.editor.getMarkdown();
        wordCount = text.trim().split(/\\s+/).filter(w => w.length > 0).length;
        statusEl.textContent = `${wordCount} words`;
      }

      // Notify Swift side of content changes (debounced)
      function notifyContentChanged() {
        clearTimeout(saveTimeout);
        statusEl.textContent = 'Saving...';

        saveTimeout = setTimeout(() => {
          const content = window.editor.getMarkdown();
          const title = titleInput.value.trim() || 'Untitled Document';

          // Update word count before sending to ensure fresh data
          updateWordCount();

          if (typeof window.vellum !== 'undefined' && typeof window.vellum.sendAction === 'function') {
            window.vellum.sendAction('content_changed', {
              title,
              content,
              wordCount
            });
          }
        }, 500);
      }

      // Listen for content changes
      window.editor.on('change', notifyContentChanged);
      titleInput.addEventListener('input', notifyContentChanged);

      // Initial word count
      updateWordCount();

      // Focus editor
      setTimeout(() => window.editor.focus(), 100);
    } catch (e) {
      var msg = String(e && e.message ? e.message : e).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      document.getElementById('editor').innerHTML =
        '<div style="padding: 32px; color: var(--v-text-secondary); font-size: 14px;">' +
        '<strong>Editor failed to load</strong><br><br>' +
        'The document editor could not be initialized. This may be due to a network issue preventing ' +
        'external assets from loading.<br><br>' +
        '<em>' + msg + '</em></div>';
    }
  </script>
</body>
</html>
"""
}

private func escapeHTML(_ str: String) -> String {
    return str
        .replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
        .replacingOccurrences(of: "\"", with: "&quot;")
        .replacingOccurrences(of: "'", with: "&#039;")
}

private func escapeJSON(_ str: String) -> String {
    guard let data = try? JSONEncoder().encode(str),
          let json = String(data: data, encoding: .utf8) else {
        return "\"\""
    }
    return json
}

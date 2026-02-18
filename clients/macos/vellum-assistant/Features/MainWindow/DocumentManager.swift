import SwiftUI
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DocumentManager")

/// Manages the state of the built-in document editor.
/// One active document at a time, displayed in the Directory panel's Documents tab.
@MainActor
final class DocumentManager: ObservableObject {
    @Published var hasActiveDocument: Bool = false
    @Published var title: String = "Untitled Document"
    @Published var surfaceId: String?
    @Published var sessionId: String?
    @Published var isSaving: Bool = false
    @Published var lastSaveError: String?

    /// Current document content and metadata
    private(set) var currentContent: String = ""
    @Published var wordCount: Int = 0

    /// Initial content from daemon — persisted for panel reopen after the coordinator consumes pendingInitialContent
    private(set) var initialContent: String = ""

    /// Pending initial content to be set when coordinator becomes ready
    private var pendingInitialContent: String?

    /// Reference to daemon client for saving documents
    weak var daemonClient: DaemonClient?

    /// Reference to the document editor coordinator for sending content updates.
    /// Set by DocumentEditorView when the coordinator is ready.
    var editorCoordinator: DocumentEditorCoordinator? {
        didSet {
            // When coordinator becomes ready, apply any pending initial content
            if let coordinator = editorCoordinator, let content = pendingInitialContent {
                coordinator.setInitialContent(title: self.title, markdown: content)
                pendingInitialContent = nil
                log.info("Applied pending initial content: title=\(self.title), length=\(content.count)")
            }
        }
    }

    func createDocument(surfaceId: String, sessionId: String, title: String, initialContent: String) {
        self.surfaceId = surfaceId
        self.sessionId = sessionId
        self.title = title
        self.initialContent = initialContent
        self.hasActiveDocument = true

        // Initialize editor with content (or store as pending if coordinator not ready)
        if let coordinator = editorCoordinator {
            coordinator.setInitialContent(title: title, markdown: initialContent)
            log.info("Document created (immediate): surfaceId=\(surfaceId), title=\(title)")
        } else {
            pendingInitialContent = initialContent
            log.info("Document created (pending): surfaceId=\(surfaceId), title=\(title), waiting for coordinator")
        }
    }

    /// Returns the content the editor WebView should load when (re)created.
    /// Clears pendingInitialContent so the coordinator didSet won't double-load.
    func contentForEditorView() -> (title: String, content: String)? {
        guard hasActiveDocument else { return nil }
        let content = currentContent.isEmpty ? initialContent : currentContent
        pendingInitialContent = nil
        return (title: title, content: content)
    }

    func updateDocument(markdown: String, mode: String) {
        guard let coordinator = editorCoordinator else {
            log.warning("⚠️ Cannot update document: editor coordinator not ready")
            print("⚠️ Cannot update document: editor coordinator not ready")
            return
        }

        print("📝 Sending update to coordinator: mode=\(mode), length=\(markdown.count)")
        coordinator.sendContentUpdate(markdown: markdown, mode: mode)
        log.info("Document updated: mode=\(mode), length=\(markdown.count)")
    }

    func updateContent(title: String, content: String, wordCount: Int) {
        self.title = title
        self.currentContent = content
        self.wordCount = wordCount
    }

    func closeDocument() {
        hasActiveDocument = false
        surfaceId = nil
        sessionId = nil
        title = "Untitled Document"
        currentContent = ""
        wordCount = 0
        initialContent = ""
        pendingInitialContent = nil
        log.info("Document closed")
    }

    func save() {
        print("💾 save() called - surfaceId: \(surfaceId ?? "nil"), sessionId: \(sessionId ?? "nil"), daemonClient: \(daemonClient != nil)")

        guard let surfaceId = surfaceId,
              let sessionId = sessionId,
              let daemonClient = daemonClient else {
            log.warning("Cannot save: missing surfaceId, sessionId, or daemonClient")
            lastSaveError = "Cannot save: missing document information"
            print("💾 ❌ Save failed: missing information")
            return
        }

        print("💾 Starting save: title=\(title), contentLength=\(currentContent.count), wordCount=\(wordCount)")
        isSaving = true
        lastSaveError = nil

        do {
            try daemonClient.sendDocumentSave(
                surfaceId: surfaceId,
                conversationId: sessionId,
                title: title,
                content: currentContent,
                wordCount: wordCount
            )
            log.info("Document save requested: \(surfaceId) - \(self.wordCount) words")
            print("💾 ✅ IPC message sent successfully")
        } catch {
            log.error("Failed to send document save: \(error.localizedDescription)")
            lastSaveError = error.localizedDescription
            isSaving = false
        }
    }

    func handleSaveResponse(success: Bool, error: String?) {
        isSaving = false
        if success {
            lastSaveError = nil
            log.info("Document saved successfully")
        } else {
            lastSaveError = error ?? "Unknown error"
            log.error("Document save failed: \(error ?? "unknown")")
        }
    }
}

/// Protocol for the document editor coordinator to implement.
/// Allows DocumentManager to send updates without depending on WKWebView details.
protocol DocumentEditorCoordinator: AnyObject {
    func setInitialContent(title: String, markdown: String)
    func sendContentUpdate(markdown: String, mode: String)
}

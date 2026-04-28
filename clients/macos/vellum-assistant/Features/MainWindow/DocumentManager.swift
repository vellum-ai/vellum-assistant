import SwiftUI
import AppKit
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "DocumentManager")

/// Manages the state of the built-in document editor.
/// One active document at a time, displayed in the Directory panel's Documents tab.
@MainActor
@Observable
final class DocumentManager {
    deinit { autoSaveTask?.cancel() }

    var hasActiveDocument: Bool = false
    var title: String = "Untitled Document"
    var surfaceId: String?
    var conversationId: String?
    var isSaving: Bool = false
    var lastSaveError: String?

    /// Current document content and metadata.
    /// `nil` means the editor has not yet received any content (uninitialized).
    /// `""` means the user intentionally deleted all text.
    private(set) var currentContent: String? = nil
    var wordCount: Int = 0

    /// Initial content from daemon persisted for panel reopen after the coordinator consumes pendingInitialContent
    private(set) var initialContent: String = ""

    /// Pending initial content to be set when coordinator becomes ready
    @ObservationIgnored private var pendingInitialContent: String?

    /// Debounced auto-save task cancelled and rescheduled on every content update
    @ObservationIgnored private var autoSaveTask: Task<Void, Never>?

    /// Reference to daemon client for saving documents
    @ObservationIgnored weak var connectionManager: GatewayConnectionManager?
    @ObservationIgnored private let documentClient: DocumentClientProtocol = DocumentClient()

    /// Reference to the document editor coordinator for sending content updates.
    /// Set by DocumentEditorView when the coordinator is ready.
    @ObservationIgnored var editorCoordinator: DocumentEditorCoordinator? {
        didSet {
            // When coordinator becomes ready, apply any pending initial content
            if let coordinator = editorCoordinator, let content = pendingInitialContent {
                coordinator.setInitialContent(title: self.title, markdown: content)
                pendingInitialContent = nil
                log.info("Applied pending initial content: title=\(self.title), length=\(content.count)")
            }
        }
    }

    func createDocument(surfaceId: String, conversationId: String, title: String, initialContent: String) {
        if hasActiveDocument {
            closeDocument()
        }
        self.surfaceId = surfaceId
        self.conversationId = conversationId
        self.title = title
        self.initialContent = initialContent
        self.currentContent = initialContent
        self.wordCount = initialContent.split(whereSeparator: \.isWhitespace).count
        self.isSaving = false
        self.lastSaveError = nil
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
    /// Uses `currentContent` when it has been initialized (including intentionally empty),
    /// falling back to `initialContent` only when `currentContent` is `nil` (never set).
    /// Clears pendingInitialContent so the coordinator didSet won't double-load.
    func contentForEditorView() -> (title: String, content: String)? {
        guard hasActiveDocument else { return nil }
        let content = currentContent ?? initialContent
        pendingInitialContent = nil
        return (title: title, content: content)
    }

    func updateDocument(markdown: String, mode: String) {
        // Always track content so it survives WebView recreation and load races
        if mode == "replace" {
            currentContent = markdown
        } else {
            let existing = currentContent ?? ""
            let sep = existing.isEmpty ? "" : "\n\n"
            currentContent = existing + sep + markdown
        }

        scheduleAutoSave()
        guard let coordinator = editorCoordinator else {
            log.warning("Cannot update document: editor coordinator not ready, content tracked for later")
            return
        }

        coordinator.sendContentUpdate(markdown: markdown, mode: mode)
        log.info("Document updated: mode=\(mode), length=\(markdown.count)")
    }

    /// Cancels any pending auto-save and schedules a new one 2 seconds from now.
    /// Fires after streaming completes so the document survives app reload.
    private func scheduleAutoSave() {
        autoSaveTask?.cancel()
        autoSaveTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            self?.save()
        }
    }

    func updateContent(title: String, content: String, wordCount: Int) {
        self.title = title
        self.currentContent = content
        self.wordCount = wordCount
    }

    func closeDocument() {
        save()
        autoSaveTask?.cancel()
        autoSaveTask = nil
        hasActiveDocument = false
        surfaceId = nil
        conversationId = nil
        title = "Untitled Document"
        currentContent = nil
        wordCount = 0
        initialContent = ""
        pendingInitialContent = nil
        isSaving = false
        lastSaveError = nil
        log.info("Document closed")
    }

    func exportToFile() {
        let content = currentContent ?? ""
        let panel = NSSavePanel()
        panel.nameFieldStringValue = sanitizedFilename(from: title) + ".md"
        panel.canCreateDirectories = true
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            DispatchQueue.global(qos: .userInitiated).async {
                try? content.write(to: url, atomically: true, encoding: .utf8)
            }
        }
    }

    private func sanitizedFilename(from title: String) -> String {
        let replaced = title.replacingOccurrences(of: " ", with: "-")
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let sanitized = replaced.unicodeScalars.filter { allowed.contains($0) }
        let result = String(String.UnicodeScalarView(sanitized))
        return result.isEmpty ? "document" : result
    }

    func save() {
        guard let surfaceId = surfaceId,
              let conversationId = conversationId else {
            return
        }

        let titleToSave = title
        let contentToSave = currentContent ?? ""
        let wordCountToSave = wordCount
        let client = documentClient
        isSaving = true
        lastSaveError = nil

        Task { [weak self] in
            let response = await client.saveDocument(
                surfaceId: surfaceId,
                conversationId: conversationId,
                title: titleToSave,
                content: contentToSave,
                wordCount: wordCountToSave
            )
            let success = response?.success ?? false
            let error = response?.error ?? (response == nil ? "Network error" : nil)
            log.info("Document save completed: \(surfaceId) - \(wordCountToSave) words - success: \(success)")
            guard let self, self.surfaceId == surfaceId else { return }
            handleSaveResponse(success: success, error: error)
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

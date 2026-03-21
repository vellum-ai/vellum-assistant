import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DebugStateWriter")

/// Periodically writes a JSON snapshot of the app's live state to a well-known
/// file path so external tools (e.g. Claude Code) can read it for instant
/// debugging context without needing the Xcode debugger or `log stream`.
///
/// File: `~/Library/Application Support/vellum-assistant/debug-state.json`
@MainActor
final class DebugStateWriter {
    private var timer: Timer?
    private weak var appDelegate: AppDelegate?

    let fileURL: URL
    private let encoder: JSONEncoder
    private let diagnosticsStore: ChatDiagnosticsStore

    init(directory: URL? = nil, diagnosticsStore: ChatDiagnosticsStore? = nil) {
        let dir: URL
        if let directory {
            dir = directory
        } else {
            let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? FileManager.default.temporaryDirectory
            dir = appSupport.appendingPathComponent("vellum-assistant", isDirectory: true)
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.fileURL = dir.appendingPathComponent("debug-state.json")

        self.diagnosticsStore = diagnosticsStore ?? ChatDiagnosticsStore.shared

        self.encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
    }

    func start(appDelegate: AppDelegate) {
        self.appDelegate = appDelegate
        captureAndWrite()
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.captureAndWrite()
            }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func captureAndWrite() {
        guard let appDelegate else { return }
        let snapshot = captureSnapshot(from: appDelegate)
        do {
            let data = try encoder.encode(snapshot)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            log.error("Failed to write debug state snapshot: \(error)")
        }
    }

    // MARK: - Snapshot Capture

    func captureSnapshot(from appDelegate: AppDelegate) -> DebugSnapshot {
        let connectionManager = appDelegate.services.connectionManager
        let conversationManager = appDelegate.mainWindow?.conversationManager

        let daemonState = DebugSnapshot.DaemonState(
            isConnected: connectionManager.isConnected,
            isConnecting: connectionManager.isConnecting,
            assistantVersion: connectionManager.assistantVersion
        )

        let conversationSnapshots: [DebugSnapshot.ConversationInfo] = (conversationManager?.conversations ?? []).map { conversation in
            let vm = conversationManager?.chatViewModel(for: conversation.id)
            return DebugSnapshot.ConversationInfo(
                id: conversation.id.uuidString,
                title: conversation.title,
                conversationId: conversation.conversationId,
                messageCount: vm?.messages.count ?? 0,
                kind: conversation.kind == .private ? "private" : "standard",
                isArchived: conversation.isArchived,
                isPinned: conversation.isPinned
            )
        }

        let conversationsState = DebugSnapshot.ConversationsState(
            activeConversationId: conversationManager?.activeConversationId?.uuidString,
            count: conversationManager?.conversations.count ?? 0,
            conversations: conversationSnapshots
        )

        var activeChatState: DebugSnapshot.ActiveChatState?
        if let vm = conversationManager?.activeViewModel {
            // Merge transcript diagnostics from the shared diagnostics store
            // when a snapshot exists for the active conversation.
            var transcriptDiagnostics: DebugSnapshot.TranscriptDiagnostics?
            if let activeConvId = conversationManager?.activeConversationId,
               let transcriptSnapshot = diagnosticsStore.snapshot(for: activeConvId.uuidString) {
                transcriptDiagnostics = DebugSnapshot.TranscriptDiagnostics(from: transcriptSnapshot)
            }

            activeChatState = DebugSnapshot.ActiveChatState(
                conversationId: vm.conversationId,
                isThinking: vm.isThinking,
                isSending: vm.isSending,
                isBootstrapping: vm.isBootstrapping,
                errorText: vm.errorText,
                conversationErrorCategory: vm.conversationError.map { "\($0.category)" },
                conversationErrorDebugDetails: vm.conversationError?.debugDetails,
                selectedModel: vm.selectedModel,
                messageCount: vm.messages.count,
                pendingQueuedCount: vm.pendingQueuedCount,
                pendingAttachmentCount: vm.pendingAttachments.count,
                isRecording: vm.isRecording,
                activeSubagentCount: vm.activeSubagents.count,
                transcriptDiagnostics: transcriptDiagnostics
            )
        }

        let cuState = DebugSnapshot.ComputerUseState(
            isActive: appDelegate.currentSession != nil,
            isStarting: appDelegate.isStartingSession
        )

        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String

        return DebugSnapshot(
            timestamp: Date(),
            appVersion: version ?? "unknown",
            daemon: daemonState,
            conversations: conversationsState,
            activeChat: activeChatState,
            computerUse: cuState
        )
    }
}

// MARK: - Snapshot Models

struct DebugSnapshot: Codable {
    let timestamp: Date
    let appVersion: String
    let daemon: DaemonState
    let conversations: ConversationsState
    let activeChat: ActiveChatState?
    let computerUse: ComputerUseState

    struct DaemonState: Codable {
        let isConnected: Bool
        let isConnecting: Bool
        let assistantVersion: String?
    }

    struct ConversationsState: Codable {
        let activeConversationId: String?
        let count: Int
        let conversations: [ConversationInfo]
    }

    struct ConversationInfo: Codable {
        let id: String
        let title: String
        let conversationId: String?
        let messageCount: Int
        let kind: String
        let isArchived: Bool
        let isPinned: Bool
    }

    struct ActiveChatState: Codable {
        let conversationId: String?
        let isThinking: Bool
        let isSending: Bool
        let isBootstrapping: Bool
        let errorText: String?
        let conversationErrorCategory: String?
        let conversationErrorDebugDetails: String?
        let selectedModel: String
        let messageCount: Int
        let pendingQueuedCount: Int
        let pendingAttachmentCount: Int
        let isRecording: Bool
        let activeSubagentCount: Int
        let transcriptDiagnostics: TranscriptDiagnostics?
    }

    /// Content-safe transcript diagnostics sourced from `ChatDiagnosticsStore`.
    ///
    /// Contains only identifiers, flags, counts, timestamps, and numeric geometry.
    /// Never includes message text, tool input/output bodies, surface HTML,
    /// or attachment data. Geometry fields are already sanitized upstream by
    /// `NumericSanitizer` — non-finite values are replaced with `nil` and their
    /// names are recorded in `nonFiniteFields`.
    struct TranscriptDiagnostics: Codable {
        let capturedAt: Date
        let messageCount: Int
        let toolCallCount: Int
        let isPinnedToBottom: Bool
        let isUserScrolling: Bool
        let scrollOffsetY: Double?
        let contentHeight: Double?
        let viewportHeight: Double?
        let isNearBottom: Bool?
        let hasReceivedScrollEvent: Bool?
        let isPaginationInFlight: Bool?
        let suppressionReason: String?
        let anchorMessageId: String?
        let highlightedMessageId: String?
        let anchorMinY: Double?
        let tailAnchorY: Double?
        let scrollViewportHeight: Double?
        let containerWidth: Double?
        let lastScrollToReason: String?
        let lastLoopWarningTimestamp: Date?
        /// Rolling event counts from `ChatScrollLoopGuard` within the 2-second
        /// detection window. Keys are event kind names; values are counts.
        /// Non-zero counts only. Useful for identifying hot paths before a freeze.
        let scrollLoopGuardCounts: [String: Int]?
        /// Names of geometry fields whose original values were non-finite
        /// (nan, inf, -inf) and were replaced with `nil` during sanitization.
        let nonFiniteFields: [String]?

        init(from snapshot: ChatTranscriptSnapshot) {
            self.capturedAt = snapshot.capturedAt
            self.messageCount = snapshot.messageCount
            self.toolCallCount = snapshot.toolCallCount
            self.isPinnedToBottom = snapshot.isPinnedToBottom
            self.isUserScrolling = snapshot.isUserScrolling
            self.scrollOffsetY = snapshot.scrollOffsetY
            self.contentHeight = snapshot.contentHeight
            self.viewportHeight = snapshot.viewportHeight
            self.isNearBottom = snapshot.isNearBottom
            self.hasReceivedScrollEvent = snapshot.hasReceivedScrollEvent
            self.isPaginationInFlight = snapshot.isPaginationInFlight
            self.suppressionReason = snapshot.suppressionReason
            self.anchorMessageId = snapshot.anchorMessageId
            self.highlightedMessageId = snapshot.highlightedMessageId
            self.anchorMinY = snapshot.anchorMinY
            self.tailAnchorY = snapshot.tailAnchorY
            self.scrollViewportHeight = snapshot.scrollViewportHeight
            self.containerWidth = snapshot.containerWidth
            self.lastScrollToReason = snapshot.lastScrollToReason
            self.lastLoopWarningTimestamp = snapshot.lastLoopWarningTimestamp
            self.scrollLoopGuardCounts = snapshot.scrollLoopGuardCounts
            self.nonFiniteFields = snapshot.nonFiniteFields
        }
    }

    struct ComputerUseState: Codable {
        let isActive: Bool
        let isStarting: Bool
    }
}

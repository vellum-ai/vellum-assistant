import AppKit
import CoreGraphics
import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "DebugStateWriter")

/// Periodically writes a JSON snapshot of the app's live state to a well-known
/// file path so external tools (e.g. Claude Code) can read it for instant
/// debugging context without needing the Xcode debugger or `log stream`.
///
/// File: `~/Library/Application Support/vellum-assistant/debug-state.json`
///
/// The capture loop is throttled under system memory pressure and when the
/// app is not frontmost. `captureSnapshot()` walks the live conversation
/// list and the LRU `ChatViewModel` cache on the main actor; when the
/// process is thrashing against a memory-pressure-induced paging storm,
/// that walk can stall the main thread for seconds. Consulting the shared
/// ``MemoryPressureMonitor`` (Apple guidance:
/// [DispatchSource.makeMemoryPressureSource](https://developer.apple.com/documentation/dispatch/dispatchsource/makememorypressuresource(eventmask:queue:))
/// and [WWDC18 — iOS Memory Deep Dive](https://developer.apple.com/videos/play/wwdc2018/416/))
/// lets us back off instead of compounding the stall.
@MainActor
final class DebugStateWriter {
    /// Capture interval when the app is frontmost and memory is healthy.
    static let activeInterval: Duration = .seconds(5)

    /// Capture interval when the app is not frontmost or the system is
    /// under non-critical memory pressure. Long enough to keep the on-disk
    /// snapshot from going fully stale without doing per-second work.
    static let throttledInterval: Duration = .seconds(30)

    /// Capture interval under critical memory pressure. At this point we
    /// skip the capture entirely and only wake periodically to check
    /// whether pressure has subsided.
    static let criticalInterval: Duration = .seconds(60)

    private var timerTask: Task<Void, Never>?
    private weak var appDelegate: AppDelegate?

    let fileURL: URL
    private let diagnosticsStore: ChatDiagnosticsStore
    private let memoryPressure: MemoryPressureMonitor
    private let isAppActive: () -> Bool

    init(
        directory: URL? = nil,
        diagnosticsStore: ChatDiagnosticsStore? = nil,
        memoryPressure: MemoryPressureMonitor = .shared,
        isAppActive: @escaping () -> Bool = { NSApp?.isActive ?? true }
    ) {
        let dir: URL
        if let directory {
            dir = directory
        } else {
            let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? FileManager.default.temporaryDirectory
            dir = appSupport.appendingPathComponent(VellumEnvironment.current.appSupportDirectoryName, isDirectory: true)
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.fileURL = dir.appendingPathComponent("debug-state.json")

        self.diagnosticsStore = diagnosticsStore ?? ChatDiagnosticsStore.shared
        self.memoryPressure = memoryPressure
        self.isAppActive = isAppActive
    }

    func start(appDelegate: AppDelegate) {
        self.appDelegate = appDelegate
        captureAndWrite()
        timerTask?.cancel()
        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                let interval = self?.nextInterval() ?? DebugStateWriter.activeInterval
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled else { break }
                self?.captureAndWrite()
            }
        }
    }

    func stop() {
        timerTask?.cancel()
        timerTask = nil
    }

    /// The sleep duration before the next capture attempt, chosen based on
    /// current system memory pressure and whether the app is frontmost.
    func nextInterval() -> Duration {
        switch memoryPressure.current {
        case .critical:
            return Self.criticalInterval
        case .warning:
            return Self.throttledInterval
        case .normal:
            return isAppActive() ? Self.activeInterval : Self.throttledInterval
        }
    }

    private func captureAndWrite() {
        guard let appDelegate else { return }
        if CGDisplayIsAsleep(CGMainDisplayID()) != 0 { return }
        // Skip when the app is backgrounded — the on-disk snapshot is only
        // useful while the user is actively interacting, and capturing
        // iterates the conversation list / LRU cache which becomes
        // expensive under memory pressure.
        if !isAppActive() { return }
        // Skip entirely under critical memory pressure. The system is about
        // to start jettisoning processes; doing work that faults pages in
        // for the conversation walk makes the stall worse.
        if memoryPressure.current == .critical { return }
        let snapshot = captureSnapshot(from: appDelegate)

        // Encode and write on a background thread to avoid blocking the main
        // thread with JSON serialization and disk I/O every 5 seconds.
        // Task.detached is used intentionally to leave @MainActor isolation.
        // A fresh encoder is created per task because JSONEncoder is a mutable
        // reference type and concurrent encode() calls would race.
        let fileURL = self.fileURL
        Task.detached(priority: .utility) {
            do {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                encoder.dateEncodingStrategy = .iso8601
                let data = try encoder.encode(snapshot)
                try data.write(to: fileURL, options: .atomic)
            } catch {
                log.error("Failed to write debug state snapshot: \(error)")
            }
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
            let vm = conversationManager?.existingChatViewModel(for: conversation.id)
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
        let hasBeenInteracted: Bool?
        let isPaginationInFlight: Bool?
        let scrollMode: String?
        let anchorMessageId: String?
        let highlightedMessageId: String?
        let anchorMinY: Double?
        let tailAnchorY: Double?
        let scrollViewportHeight: Double?
        let containerWidth: Double?
        let lastScrollToReason: String?
        /// Legacy field, always `nil`. Retained for backward compatibility.
        let lastLoopWarningTimestamp: Date?
        /// Legacy field, always `nil`. Retained for backward compatibility.
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
            self.hasBeenInteracted = snapshot.hasBeenInteracted
            self.isPaginationInFlight = snapshot.isPaginationInFlight
            self.scrollMode = snapshot.scrollMode
            self.anchorMessageId = snapshot.anchorMessageId
            self.highlightedMessageId = snapshot.highlightedMessageId
            self.anchorMinY = snapshot.anchorMinY
            self.tailAnchorY = snapshot.tailAnchorY
            self.scrollViewportHeight = snapshot.scrollViewportHeight
            self.containerWidth = snapshot.containerWidth
            self.lastScrollToReason = snapshot.lastScrollToReason
            self.lastLoopWarningTimestamp = nil
            self.scrollLoopGuardCounts = nil
            self.nonFiniteFields = snapshot.nonFiniteFields
        }
    }

    struct ComputerUseState: Codable {
        let isActive: Bool
        let isStarting: Bool
    }
}

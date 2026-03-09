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

    private let fileURL: URL
    private let encoder: JSONEncoder

    init() {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let dir = appSupport.appendingPathComponent("vellum-assistant", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.fileURL = dir.appendingPathComponent("debug-state.json")

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

    private func captureSnapshot(from appDelegate: AppDelegate) -> DebugSnapshot {
        let daemonClient = appDelegate.services.daemonClient
        let threadManager = appDelegate.mainWindow?.threadManager

        let transport: String
        switch daemonClient.config.transport {
        case .http:
            transport = "http"
        }

        let daemonState = DebugSnapshot.DaemonState(
            isConnected: daemonClient.isConnected,
            isConnecting: daemonClient.isConnecting,
            daemonVersion: daemonClient.daemonVersion,
            transport: transport
        )

        let threadSnapshots: [DebugSnapshot.ThreadInfo] = (threadManager?.threads ?? []).map { thread in
            let vm = threadManager?.chatViewModel(for: thread.id)
            return DebugSnapshot.ThreadInfo(
                id: thread.id.uuidString,
                title: thread.title,
                sessionId: thread.sessionId,
                messageCount: vm?.messages.count ?? 0,
                kind: thread.kind == .private ? "private" : "standard",
                isArchived: thread.isArchived,
                isPinned: thread.isPinned
            )
        }

        let threadsState = DebugSnapshot.ThreadsState(
            activeThreadId: threadManager?.activeThreadId?.uuidString,
            count: threadManager?.threads.count ?? 0,
            threads: threadSnapshots
        )

        var activeChatState: DebugSnapshot.ActiveChatState?
        if let vm = threadManager?.activeViewModel {
            activeChatState = DebugSnapshot.ActiveChatState(
                sessionId: vm.sessionId,
                isThinking: vm.isThinking,
                isSending: vm.isSending,
                isBootstrapping: vm.isBootstrapping,
                errorText: vm.errorText,
                sessionErrorCategory: vm.sessionError.map { "\($0.category)" },
                selectedModel: vm.selectedModel,
                messageCount: vm.messages.count,
                pendingQueuedCount: vm.pendingQueuedCount,
                pendingAttachmentCount: vm.pendingAttachments.count,
                isRecording: vm.isRecording,
                activeSubagentCount: vm.activeSubagents.count
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
            threads: threadsState,
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
    let threads: ThreadsState
    let activeChat: ActiveChatState?
    let computerUse: ComputerUseState

    struct DaemonState: Codable {
        let isConnected: Bool
        let isConnecting: Bool
        let daemonVersion: String?
        let transport: String
    }

    struct ThreadsState: Codable {
        let activeThreadId: String?
        let count: Int
        let threads: [ThreadInfo]
    }

    struct ThreadInfo: Codable {
        let id: String
        let title: String
        let sessionId: String?
        let messageCount: Int
        let kind: String
        let isArchived: Bool
        let isPinned: Bool
    }

    struct ActiveChatState: Codable {
        let sessionId: String?
        let isThinking: Bool
        let isSending: Bool
        let isBootstrapping: Bool
        let errorText: String?
        let sessionErrorCategory: String?
        let selectedModel: String
        let messageCount: Int
        let pendingQueuedCount: Int
        let pendingAttachmentCount: Int
        let isRecording: Bool
        let activeSubagentCount: Int
    }

    struct ComputerUseState: Codable {
        let isActive: Bool
        let isStarting: Bool
    }
}

import Combine
import SwiftUI
import VellumAssistantShared
import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ThreadManager")
private let archivedSessionsKey = "archivedSessionIds"

@MainActor
final class ThreadManager: ObservableObject, ThreadRestorerDelegate {
    @AppStorage("restoreRecentThreads") private(set) var restoreRecentThreads = true
    @Published var threads: [ThreadModel] = []
    @Published var activeThreadId: UUID? {
        didSet {
            subscribeToActiveViewModel()
            if let activeThreadId {
                sessionRestorer.loadHistoryIfNeeded(threadId: activeThreadId)
            }
        }
    }

    private var chatViewModels: [UUID: ChatViewModel] = [:]
    private let daemonClient: DaemonClient
    private var viewModelCancellable: AnyCancellable?
    private let sessionRestorer: ThreadSessionRestorer
    private let activityNotificationService: ActivityNotificationService?

    /// Called when an inline confirmation response should dismiss the floating panel.
    var confirmationDismissHandler: ((String) -> Void)?

    /// Threads that are not archived — used by the UI to populate the sidebar/tab bar.
    var visibleThreads: [ThreadModel] {
        threads.filter { !$0.isArchived }
    }

    var archivedThreads: [ThreadModel] {
        threads.filter { $0.isArchived }
    }

    var activeViewModel: ChatViewModel? {
        guard let activeThreadId else { return nil}
        return chatViewModels[activeThreadId]
    }

    init(daemonClient: DaemonClient, activityNotificationService: ActivityNotificationService? = nil) {
        self.daemonClient = daemonClient
        self.activityNotificationService = activityNotificationService
        self.sessionRestorer = ThreadSessionRestorer(daemonClient: daemonClient)
        // Create one default thread so the window is never empty
        createThread()
        sessionRestorer.delegate = self
        sessionRestorer.startObserving()
    }

    func createThread() {
        // If the active thread is still empty, just keep it instead of creating another
        if let activeId = activeThreadId,
           let vm = chatViewModels[activeId],
           !vm.messages.contains(where: { $0.role == .user }) {
            return
        }

        let thread = ThreadModel()
        let viewModel = makeViewModel()
        let threadId = thread.id
        viewModel.onFirstUserMessage = { [weak self] text in
            self?.updateThreadTitle(id: threadId, title: "Untitled")
            Task { @MainActor in
                await self?.generateTitle(for: threadId, userMessage: text)
            }
        }
        threads.insert(thread, at: 0)
        chatViewModels[thread.id] = viewModel
        activeThreadId = thread.id
        log.info("Created thread \(thread.id) with title \"\(thread.title)\"")
    }

    func closeThread(id: UUID) {
        // No-op if only 1 thread remains
        guard threads.count > 1 else { return }

        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }

        // Cancel any active generation so the daemon doesn't keep processing
        // an orphaned request after the view model is removed.
        chatViewModels[id]?.stopGenerating()

        threads.remove(at: index)
        chatViewModels.removeValue(forKey: id)

        // If the closed thread was active, select an adjacent thread
        if activeThreadId == id {
            // Prefer the thread at the same index (next), otherwise fall back to last
            if index < threads.count {
                activeThreadId = threads[index].id
            } else {
                activeThreadId = threads.last?.id
            }
        }

        log.info("Closed thread \(id)")
    }

    func archiveThread(id: UUID) {
        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }

        threads[index].isArchived = true

        if let sessionId = threads[index].sessionId {
            chatViewModels[id]?.stopGenerating()
            var archived = archivedSessionIds
            archived.insert(sessionId)
            archivedSessionIds = archived
            // Session ID already known — safe to release the view model.
            chatViewModels.removeValue(forKey: id)
        } else if chatViewModels[id]?.messages.contains(where: { $0.role == .user }) != true
                    && chatViewModels[id]?.isBootstrapping != true {
            chatViewModels[id]?.stopGenerating()
            // No session ID, no user messages, and no bootstrap in flight —
            // a session will never be created, so there is nothing to backfill.
            // Clean up immediately.
            chatViewModels.removeValue(forKey: id)
        } else {
            // Session ID is nil but a session is expected (user messages exist
            // or bootstrap is in flight, e.g. a workspace refinement that
            // doesn't append a user message). Keep the ChatViewModel alive so
            // the onSessionCreated callback can fire, claim its own session via
            // the correlation ID, persist the archive state via backfillSessionId,
            // and then clean up. Use cancelPendingMessage() instead of
            // stopGenerating() to discard the queued message without clearing the
            // correlation ID — this prevents the VM from claiming an unrelated
            // session_info from another thread.
            chatViewModels[id]?.cancelPendingMessage()
        }

        // If the archived thread was active, select an adjacent visible thread
        // or create a new one if none remain.
        if activeThreadId == id {
            // Find the position of the archived thread among visible threads
            // (before archiving filtered it out) and pick the neighbor.
            let visible = visibleThreads
            if !visible.isEmpty {
                // The archived thread was at `index` in the full `threads` array.
                // Find the closest visible thread by scanning neighbors.
                let visibleAfter = threads[index...].dropFirst().first(where: { !$0.isArchived })
                let visibleBefore = threads[..<index].last(where: { !$0.isArchived })
                if let next = visibleAfter ?? visibleBefore {
                    activeThreadId = next.id
                } else {
                    activeThreadId = visible.first?.id
                }
            } else {
                createThread()
            }
        }

        log.info("Archived thread \(id)")
    }

    func unarchiveThread(id: UUID) {
        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }

        threads[index].isArchived = false

        // Re-create the ChatViewModel since it was removed on archive.
        if chatViewModels[id] == nil {
            let viewModel = makeViewModel()
            viewModel.sessionId = threads[index].sessionId
            chatViewModels[id] = viewModel
        }

        if let sessionId = threads[index].sessionId {
            var archived = archivedSessionIds
            archived.remove(sessionId)
            archivedSessionIds = archived
        }

        log.info("Unarchived thread \(id)")
    }

    func isSessionArchived(_ sessionId: String) -> Bool {
        archivedSessionIds.contains(sessionId)
    }

    /// Clear the `activeSurfaceId` on a specific thread's ChatViewModel.
    /// Used when switching threads to prevent stale surface context injection.
    func clearActiveSurface(threadId: UUID) {
        chatViewModels[threadId]?.activeSurfaceId = nil
    }

    func selectThread(id: UUID) {
        guard threads.contains(where: { $0.id == id }) else { return }
        activeThreadId = id
    }

    /// Returns true if the thread has at least one user message.
    func threadHasMessages(_ id: UUID) -> Bool {
        chatViewModels[id]?.messages.contains(where: { $0.role == .user }) ?? false
    }

    /// Update confirmation state across ALL chat view models, not just the active one.
    /// This ensures that when the floating panel responds, the originating thread's
    /// inline confirmation is updated even if the user switched threads.
    func updateConfirmationStateAcrossThreads(requestId: String, decision: String) {
        for viewModel in chatViewModels.values {
            viewModel.updateConfirmationState(requestId: requestId, decision: decision)
        }
    }

    /// Returns true if the given ChatViewModel is the one that most recently
    /// received a `toolUseStart` event across all threads. Used to route
    /// `confirmationRequest` messages (which lack a sessionId) to exactly
    /// one ChatViewModel, preventing duplicates and ensuring confirmations
    /// are accepted even in flows that don't go through `sendMessage()`.
    func isLatestToolUseRecipient(_ viewModel: ChatViewModel) -> Bool {
        guard let timestamp = viewModel.lastToolUseReceivedAt else { return false }
        for other in chatViewModels.values where other !== viewModel {
            if let otherTimestamp = other.lastToolUseReceivedAt, otherTimestamp > timestamp {
                return false
            }
        }
        return true
    }

    // MARK: - ThreadRestorerDelegate

    func chatViewModel(for threadId: UUID) -> ChatViewModel? {
        chatViewModels[threadId]
    }

    func setChatViewModel(_ vm: ChatViewModel, for threadId: UUID) {
        chatViewModels[threadId] = vm
    }

    func removeChatViewModel(for threadId: UUID) {
        chatViewModels.removeValue(forKey: threadId)
    }

    /// The ambient agent instance, set by the app layer so watch session callbacks
    /// can create and manage WatchSession objects.
    weak var ambientAgent: AmbientAgent?

    func updateThreadTitle(id: UUID, title: String) {
        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }
        threads[index].title = title
    }

    func makeViewModel() -> ChatViewModel {
        let viewModel = ChatViewModel(daemonClient: daemonClient, onToolCallsComplete: { [weak self] toolCalls in
            guard let self, let service = self.activityNotificationService else { return }
            // Send notification when tool calls complete
            Task { @MainActor in
                await service.notifySessionComplete(
                    summary: "Tool execution completed",
                    steps: toolCalls.count,
                    toolCalls: toolCalls,
                    sessionId: "" // Session ID not needed for chat-based notifications
                )
            }
        })
        viewModel.onInlineConfirmationResponse = { [weak self] requestId in
            self?.confirmationDismissHandler?(requestId)
        }
        viewModel.shouldAcceptConfirmation = { [weak self, weak viewModel] in
            guard let self, let viewModel else { return false }
            return self.isLatestToolUseRecipient(viewModel)
        }
        viewModel.onWatchStarted = { [weak self] msg, client in
            guard let self else { return }
            let session = WatchSession(
                watchId: msg.watchId,
                sessionId: msg.sessionId,
                durationSeconds: Int(msg.durationSeconds),
                intervalSeconds: Int(msg.intervalSeconds)
            )
            self.ambientAgent?.activeWatchSession = session
            session.start(daemonClient: client)
        }
        viewModel.onWatchCompleteRequest = { [weak self] _ in
            self?.ambientAgent?.activeWatchSession?.stop()
            self?.ambientAgent?.activeWatchSession = nil
        }
        viewModel.onStopWatch = { [weak self] in
            self?.ambientAgent?.activeWatchSession?.stop()
            self?.ambientAgent?.activeWatchSession = nil
        }
        viewModel.onSessionCreated = { [weak self, weak viewModel] sessionId in
            guard let self, let viewModel else { return }
            self.backfillSessionId(sessionId, for: viewModel)
        }
        return viewModel
    }

    func activateThread(_ id: UUID) {
        activeThreadId = id
    }

    /// Derive a short title from the first user message, truncated at a word boundary around 50 chars.
    static func deriveTitle(from text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "New Conversation" }
        if trimmed.count <= 50 { return trimmed }
        let prefix = trimmed.prefix(50)
        // Find the last space to break at a word boundary
        if let lastSpace = prefix.lastIndex(of: " ") {
            return String(prefix[prefix.startIndex..<lastSpace]) + "..."
        }
        return String(prefix) + "..."
    }

    /// Generate a conversation title via LLM and update the thread.
    private func generateTitle(for threadId: UUID, userMessage: String) async {
        let fallback = Self.deriveTitle(from: userMessage)

        guard let apiKey = APIKeyManager.getKey() else {
            log.warning("No API key available for title generation")
            updateThreadTitle(id: threadId, title: fallback)
            return
        }

        let client = AnthropicClient(apiKey: apiKey)
        let tool: [String: Any] = [
            "name": "set_title",
            "description": "Set a short conversation title",
            "input_schema": [
                "type": "object",
                "required": ["title"],
                "properties": [
                    "title": [
                        "type": "string",
                        "description": "A concise conversation title, 2-6 words. Sentence case. No quotes, no markdown."
                    ]
                ]
            ]
        ]

        do {
            let result = try await client.sendToolUseRequest(
                model: "claude-haiku-4-5-20251001",
                maxTokens: 60,
                system: "Generate a short, descriptive title (2-6 words) for this conversation based on the user's first message. Use sentence case (only capitalize the first word and proper nouns). Be specific and concise. Never use quotes, asterisks, or any markdown formatting.",
                tools: [tool],
                toolChoice: ["type": "any"],
                messages: [["role": "user", "content": userMessage]],
                timeout: 10
            )
            if let raw = result.input["title"] as? String, !raw.isEmpty {
                let title = raw.replacingOccurrences(of: "*", with: "")
                    .replacingOccurrences(of: "#", with: "")
                    .replacingOccurrences(of: "\"", with: "")
                    .replacingOccurrences(of: "_", with: " ")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                updateThreadTitle(id: threadId, title: title.isEmpty ? fallback : title)
            }
        } catch {
            log.warning("Title generation failed: \(error.localizedDescription)")
            updateThreadTitle(id: threadId, title: fallback)
        }
    }

    // MARK: - Private

    /// Backfill ThreadModel.sessionId when the daemon assigns a session to a new thread.
    private func backfillSessionId(_ sessionId: String, for viewModel: ChatViewModel) {
        guard let threadId = chatViewModels.first(where: { $0.value === viewModel })?.key,
              let index = threads.firstIndex(where: { $0.id == threadId }),
              threads[index].sessionId == nil else { return }
        threads[index].sessionId = sessionId
        // If the thread was archived before the session ID arrived,
        // persist the archive state now that we have a session ID and
        // release the view model that was kept alive for this callback.
        if threads[index].isArchived {
            var archived = archivedSessionIds
            archived.insert(sessionId)
            archivedSessionIds = archived
            chatViewModels.removeValue(forKey: threadId)
        }
    }

    private var archivedSessionIds: Set<String> {
        get {
            Set(UserDefaults.standard.stringArray(forKey: archivedSessionsKey) ?? [])
        }
        set {
            UserDefaults.standard.set(Array(newValue), forKey: archivedSessionsKey)
        }
    }

    /// Subscribe to the active ChatViewModel's objectWillChange so that
    /// SwiftUI re-evaluates views when the nested view model publishes
    /// changes (new messages, thinking state, errors, etc.).
    private func subscribeToActiveViewModel() {
        viewModelCancellable = activeViewModel?.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
    }
}

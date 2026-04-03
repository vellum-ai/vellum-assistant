import Foundation
import Observation
import VellumAssistantShared

/// Owns per-conversation activity state (busy flags, interaction states, active
/// message count) on an `@Observable` class so SwiftUI views get **property-level**
/// tracking instead of the broad `objectWillChange` signal that
/// `ObservableObject` emits.
///
/// Before this extraction, `ConversationManager` held these values as `@Published`
/// properties. Every message-stream token, every send/think toggle wrote to a
/// `@Published` var → fired `objectWillChange` → invalidated the entire view tree
/// rooted at `MainWindowView`. Moving the high-churn state here breaks that
/// cascade: only views that actually read a specific property re-evaluate.
///
/// Observation is done via `withObservationTracking` loops that read directly from
/// `ChatMessageManager` and `ChatErrorManager` `@Observable` properties. Each loop
/// re-arms itself on change and is guarded by a generation
/// counter so it can be cleanly invalidated when a conversation is switched,
/// closed, or archived.
///
/// - SeeAlso: [Migrating from ObservableObject to Observable](https://developer.apple.com/documentation/swiftui/migrating-from-the-observable-object-protocol-to-the-observable-macro)
/// - SeeAlso: [WWDC23 — Discover Observation in SwiftUI](https://developer.apple.com/videos/play/wwdc2023/10149/)
/// - SeeAlso: [Observation framework](https://developer.apple.com/documentation/observation)
@MainActor @Observable
final class ConversationActivityStore {

    // MARK: - Observable state

    /// Conversation IDs whose ChatViewModel indicates active processing
    /// (sending, thinking, or queued messages).
    private(set) var busyConversationIds: Set<UUID> = []

    /// Per-conversation interaction state derived from ChatViewModel properties.
    /// Priority: error > waitingForInput > processing > idle.
    private(set) var conversationInteractionStates: [UUID: ConversationInteractionState] = [:]

    /// Message count of the active conversation's view model.
    /// Views that need to react to new messages observe this instead of
    /// subscribing to ConversationManager.objectWillChange.
    private(set) var activeMessageCount: Int = 0

    // MARK: - Observation lifecycle

    /// Generation counters for invalidating busy-state observation loops.
    @ObservationIgnored private var busyGenerations: [UUID: Int] = [:]

    /// Generation counters for invalidating interaction-state observation loops.
    @ObservationIgnored private var interactionGenerations: [UUID: Int] = [:]

    /// Generation counter for invalidating the active-VM message count loop.
    @ObservationIgnored private var activeVMGeneration: Int = 0

    /// Tracks the previous interaction state per conversation so sound effects
    /// only fire on discrete transitions, not on every streaming delta.
    @ObservationIgnored private var previousInteractionStates: [UUID: ConversationInteractionState] = [:]

    /// Whether the initial interaction state has been observed for each
    /// conversation. Prevents sounds from firing on initial subscription
    /// (e.g., a conversation that loads in an error state).
    @ObservationIgnored private var hasInitialInteractionState: [UUID: Bool] = [:]

    /// Callback invoked when a conversation transitions from busy → idle.
    /// ConversationManager uses this to drain pending notification catch-ups.
    @ObservationIgnored var onBusyToIdle: ((UUID) -> Void)?

    // MARK: - Assistant activity observation

    /// Snapshot of the latest assistant message's structural properties,
    /// used to detect meaningful changes (new messages, tool completions,
    /// streaming state transitions) without deep-diffing the full message list.
    struct AssistantActivitySnapshot: Equatable {
        let messageId: UUID
        let toolCallCount: Int
        let completedToolCallCount: Int
        let surfaceCount: Int
        let isStreaming: Bool
    }

    /// Generation counters for invalidating assistant-activity observation loops.
    @ObservationIgnored private var activityGenerations: [UUID: Int] = [:]

    /// Last observed assistant activity snapshot per conversation.
    @ObservationIgnored private(set) var latestAssistantActivitySnapshots: [UUID: AssistantActivitySnapshot] = [:]

    /// Callback invoked when assistant activity changes for a conversation.
    /// Parameters: (conversationId, previousSnapshot, currentSnapshot).
    @ObservationIgnored var onAssistantActivityChange: ((UUID, AssistantActivitySnapshot?, AssistantActivitySnapshot) -> Void)?

    // MARK: - Public API

    /// Whether the given conversation's ChatViewModel indicates active processing.
    func isConversationBusy(_ conversationId: UUID) -> Bool {
        busyConversationIds.contains(conversationId)
    }

    /// Returns the derived interaction state for a conversation, defaulting to `.idle`.
    func interactionState(for conversationId: UUID) -> ConversationInteractionState {
        conversationInteractionStates[conversationId] ?? .idle
    }

    // MARK: - Start observation

    /// Begin observing busy-state properties on a ChatViewModel's message manager.
    ///
    /// Uses `withObservationTracking` to read `isSending`, `isThinking`, and
    /// `pendingQueuedCount` directly from the `@Observable` ChatMessageManager.
    /// The observation loop re-arms itself on each change and is invalidated
    /// via generation counter when the conversation is unsubscribed.
    func observeBusyState(for conversationId: UUID, messageManager: ChatMessageManager) {
        let generation = (busyGenerations[conversationId] ?? 0) + 1
        busyGenerations[conversationId] = generation
        observeBusyStateLoop(conversationId: conversationId, messageManager: messageManager, generation: generation)
    }

    /// Begin observing interaction-state properties on a ChatViewModel.
    ///
    /// Reads from both `ChatMessageManager` and `ChatErrorManager` in a single
    /// `withObservationTracking` closure, so a change to any tracked property
    /// triggers re-evaluation.
    func observeInteractionState(
        for conversationId: UUID,
        messageManager: ChatMessageManager,
        errorManager: ChatErrorManager
    ) {
        let generation = (interactionGenerations[conversationId] ?? 0) + 1
        interactionGenerations[conversationId] = generation
        hasInitialInteractionState[conversationId] = false
        previousInteractionStates.removeValue(forKey: conversationId)
        observeInteractionStateLoop(
            conversationId: conversationId,
            messageManager: messageManager,
            errorManager: errorManager,
            generation: generation
        )
    }

    /// Begin observing assistant activity on a ChatViewModel's message manager.
    ///
    /// Uses `withObservationTracking` to read `messages` directly from the
    /// `@Observable` ChatMessageManager, deriving an `AssistantActivitySnapshot`
    /// and comparing with the previous snapshot. On change, invokes
    /// `onAssistantActivityChange` so ConversationManager can update unseen state.
    func observeAssistantActivity(for conversationId: UUID, messageManager: ChatMessageManager) {
        let generation = (activityGenerations[conversationId] ?? 0) + 1
        activityGenerations[conversationId] = generation
        // Seed with the initial snapshot.
        let initialSnapshot = Self.assistantActivitySnapshot(from: messageManager.messages)
        if let initialSnapshot {
            latestAssistantActivitySnapshots[conversationId] = initialSnapshot
        } else {
            latestAssistantActivitySnapshots.removeValue(forKey: conversationId)
        }
        observeAssistantActivityLoop(conversationId: conversationId, messageManager: messageManager, generation: generation)
    }

    /// Begin observing the active conversation's message count.
    ///
    /// Called when the active conversation changes. Invalidates any prior
    /// observation loop and starts a new one for the given message manager.
    func observeActiveViewModel(_ messageManager: ChatMessageManager?) {
        activeVMGeneration += 1
        activeMessageCount = 0
        guard let messageManager else { return }
        let generation = activeVMGeneration
        observeActiveMessageCountLoop(messageManager: messageManager, generation: generation)
    }

    // MARK: - Stop observation

    /// Remove busy-state and interaction-state observation for a conversation.
    ///
    /// Does NOT clear `conversationInteractionStates` — the last known
    /// interaction state is preserved so that evicted (but still visible)
    /// conversations continue showing the correct sidebar cue. Callers that
    /// permanently remove a conversation should use
    /// `unsubscribeAll(for:)` instead.
    func unsubscribeFromBusyState(for conversationId: UUID) {
        invalidateBusyGeneration(for: conversationId)
        invalidateInteractionGeneration(for: conversationId)
        invalidateActivityGeneration(for: conversationId)
        busyConversationIds.remove(conversationId)
        latestAssistantActivitySnapshots.removeValue(forKey: conversationId)
    }

    /// Cancel all observation and remove cached state for a conversation that
    /// is being permanently removed (closed, archived, or backfill-discarded).
    func unsubscribeAll(for conversationId: UUID) {
        invalidateBusyGeneration(for: conversationId)
        invalidateInteractionGeneration(for: conversationId)
        invalidateActivityGeneration(for: conversationId)
        busyConversationIds.remove(conversationId)
        conversationInteractionStates.removeValue(forKey: conversationId)
        previousInteractionStates.removeValue(forKey: conversationId)
        hasInitialInteractionState.removeValue(forKey: conversationId)
        latestAssistantActivitySnapshots.removeValue(forKey: conversationId)
    }

    // MARK: - Busy state observation loop

    private func observeBusyStateLoop(
        conversationId: UUID,
        messageManager: ChatMessageManager,
        generation: Int
    ) {
        guard busyGenerations[conversationId] == generation else { return }

        var isBusy = false
        withObservationTracking {
            isBusy = messageManager.isSending || messageManager.isThinking || messageManager.pendingQueuedCount > 0
        } onChange: { [weak self, weak messageManager] in
            Task { @MainActor [weak self, weak messageManager] in
                guard let self, let messageManager else { return }
                self.observeBusyStateLoop(
                    conversationId: conversationId,
                    messageManager: messageManager,
                    generation: generation
                )
            }
        }

        let wasBusy = busyConversationIds.contains(conversationId)
        if isBusy {
            busyConversationIds.insert(conversationId)
        } else {
            busyConversationIds.remove(conversationId)
            if wasBusy {
                onBusyToIdle?(conversationId)
            }
        }
    }

    // MARK: - Interaction state observation loop

    private func observeInteractionStateLoop(
        conversationId: UUID,
        messageManager: ChatMessageManager,
        errorManager: ChatErrorManager,
        generation: Int
    ) {
        guard interactionGenerations[conversationId] == generation else { return }

        var state = ConversationInteractionState.idle
        withObservationTracking {
            let hasError = errorManager.errorText != nil || errorManager.conversationError != nil
            let hasPendingConfirmation = messageManager.hasPendingConfirmation
            let isBusy = messageManager.isSending || messageManager.isThinking || messageManager.pendingQueuedCount > 0

            if hasError {
                state = .error
            } else if hasPendingConfirmation {
                state = .waitingForInput
            } else if isBusy {
                state = .processing
            }
        } onChange: { [weak self, weak messageManager, weak errorManager] in
            Task { @MainActor [weak self, weak messageManager, weak errorManager] in
                guard let self, let messageManager, let errorManager else { return }
                self.observeInteractionStateLoop(
                    conversationId: conversationId,
                    messageManager: messageManager,
                    errorManager: errorManager,
                    generation: generation
                )
            }
        }

        let previous = previousInteractionStates[conversationId]
        let isInitial = hasInitialInteractionState[conversationId] != true
        hasInitialInteractionState[conversationId] = true

        // Only update stored state if it actually changed (equivalent to .removeDuplicates()).
        guard state != previous || isInitial else { return }
        previousInteractionStates[conversationId] = state

        if state == .idle {
            conversationInteractionStates.removeValue(forKey: conversationId)
        } else {
            conversationInteractionStates[conversationId] = state
        }

        // Play sounds on discrete state transitions. Skip the initial observation
        // to avoid sounds firing when a conversation loads in an error state.
        guard !isInitial else { return }
        switch state {
        case .idle where previous == .processing:
            SoundManager.shared.play(.taskComplete)
        case .waitingForInput:
            SoundManager.shared.play(.needsInput)
        case .error:
            SoundManager.shared.play(.taskFailed)
        default:
            break
        }
    }

    // MARK: - Assistant activity observation loop

    private func observeAssistantActivityLoop(
        conversationId: UUID,
        messageManager: ChatMessageManager,
        generation: Int
    ) {
        guard activityGenerations[conversationId] == generation else { return }

        var snapshot: AssistantActivitySnapshot?
        withObservationTracking {
            snapshot = Self.assistantActivitySnapshot(from: messageManager.messages)
        } onChange: { [weak self, weak messageManager] in
            Task { @MainActor [weak self, weak messageManager] in
                guard let self, let messageManager else { return }
                self.observeAssistantActivityLoop(
                    conversationId: conversationId,
                    messageManager: messageManager,
                    generation: generation
                )
            }
        }

        let previousSnapshot = latestAssistantActivitySnapshots[conversationId]
        if let snapshot {
            latestAssistantActivitySnapshots[conversationId] = snapshot
        } else {
            latestAssistantActivitySnapshots.removeValue(forKey: conversationId)
        }
        guard previousSnapshot != snapshot, let snapshot else { return }
        onAssistantActivityChange?(conversationId, previousSnapshot, snapshot)
    }

    /// Derive a structural snapshot from the latest assistant message in the list.
    private static func assistantActivitySnapshot(from messages: [ChatMessage]) -> AssistantActivitySnapshot? {
        guard let message = messages.reversed().first(where: { $0.role == .assistant }) else { return nil }
        return AssistantActivitySnapshot(
            messageId: message.id,
            toolCallCount: message.toolCalls.count,
            completedToolCallCount: message.toolCalls.filter(\.isComplete).count,
            surfaceCount: message.inlineSurfaces.count,
            isStreaming: message.isStreaming
        )
    }

    // MARK: - Active message count observation loop

    private func observeActiveMessageCountLoop(
        messageManager: ChatMessageManager,
        generation: Int
    ) {
        guard activeVMGeneration == generation else { return }

        var count = 0
        withObservationTracking {
            count = messageManager.messages.count
        } onChange: { [weak self, weak messageManager] in
            Task { @MainActor [weak self, weak messageManager] in
                guard let self, let messageManager else { return }
                self.observeActiveMessageCountLoop(
                    messageManager: messageManager,
                    generation: generation
                )
            }
        }

        if count != activeMessageCount {
            activeMessageCount = count
        }
    }

    // MARK: - Private helpers

    private func invalidateBusyGeneration(for conversationId: UUID) {
        if let gen = busyGenerations[conversationId] {
            busyGenerations[conversationId] = gen + 1
        }
    }

    private func invalidateInteractionGeneration(for conversationId: UUID) {
        if let gen = interactionGenerations[conversationId] {
            interactionGenerations[conversationId] = gen + 1
        }
    }

    private func invalidateActivityGeneration(for conversationId: UUID) {
        if let gen = activityGenerations[conversationId] {
            activityGenerations[conversationId] = gen + 1
        }
    }
}

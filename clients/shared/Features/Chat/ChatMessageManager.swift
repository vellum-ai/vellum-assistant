import Combine
import Foundation
import Observation
import os
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#else
#error("Unsupported platform")
#endif

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ChatMessageManager")

/// Owns message-list state, send/thinking flags, and assistant activity properties.
/// ChatViewModel forwards reads/writes via computed properties so call sites
/// access state through `viewModel.messages`, `viewModel.isSending`, etc.
///
/// `messages` uses a custom getter/setter that participates in the Observation
/// framework via `access(keyPath:)` / `withMutation(keyPath:)` while also
/// publishing to a Combine `CurrentValueSubject`. SwiftUI views get
/// fine-grained property tracking; non-view consumers (pagination, voice mode,
/// conversation manager, iOS store) subscribe to `messagesPublisher`.
///
/// The `_modify` accessor defers the Combine publish via a coalesced
/// `Task { @MainActor }`, so multiple rapid subscript mutations (e.g.
/// `stopGenerating`) result in a single downstream notification instead of
/// one per mutation.
///
/// - SeeAlso: [Observation framework — custom access](https://developer.apple.com/documentation/observation)
/// - SeeAlso: [WWDC23 — Discover Observation in SwiftUI](https://developer.apple.com/videos/play/wwdc2023/10149/)
@MainActor @Observable
public final class ChatMessageManager {

    // MARK: - Message list

    /// The full message array. The custom getter/setter participates in the
    /// Observation framework (`access`/`withMutation`) while also publishing
    /// to `_messagesSubject` so Combine subscribers stay in sync.
    ///
    /// - `set`: publishes synchronously (the caller intends a complete replacement).
    /// - `_modify`: defers the publish via `scheduleDeferredPublish()` so
    ///   multiple rapid subscript mutations coalesce into one notification.
    public var messages: [ChatMessage] {
        get {
            access(keyPath: \.messages)
            return _messagesStorage
        }
        set {
            withMutation(keyPath: \.messages) {
                _messagesStorage = newValue
            }
            advanceMessagesRevision()
            _deferredPublishTask?.cancel()
            _deferredPublishTask = nil
            _messagesSubject.send(newValue)
        }
        // swiftlint:disable:next identifier_name
        _modify {
            _$observationRegistrar.willSet(self, keyPath: \.messages)
            defer {
                _$observationRegistrar.didSet(self, keyPath: \.messages)
                advanceMessagesRevision()
                scheduleDeferredPublish()
            }
            yield &_messagesStorage
        }
    }
    @ObservationIgnored private var _messagesStorage: [ChatMessage] = []

    /// Monotonically increasing revision for any `messages` mutation.
    /// Transcript caches use this to invalidate on content-only edits to
    /// existing messages, not just count or ID changes.
    public private(set) var messagesRevision: UInt64 = 0

    private func advanceMessagesRevision() {
        messagesRevision &+= 1
    }

    /// Apply multiple mutations to the message array in a single batch,
    /// emitting only one Observation notification and one Combine publish
    /// at the end. Use for loops that modify many elements (trim, status
    /// resets) to avoid per-mutation downstream work.
    public func batchUpdateMessages(_ body: (inout [ChatMessage]) -> Void) {
        withMutation(keyPath: \.messages) {
            body(&_messagesStorage)
        }
        advanceMessagesRevision()
        // Cancel any pending deferred publish — this synchronous publish
        // supersedes it with the final post-batch snapshot.
        _deferredPublishTask?.cancel()
        _deferredPublishTask = nil
        _messagesSubject.send(_messagesStorage)
    }

    /// Active pending confirmation request ID, derived from `messages`.
    /// Views read this O(1) cached value instead of scanning the message
    /// array each render cycle. Recomputed by `recomputeDerivedValues(from:)`.
    public private(set) var activePendingRequestId: String?

    /// Whether any message has a pending confirmation (including system
    /// permission requests). Unlike `activePendingRequestId` — which excludes
    /// `request_system_permission` for keyboard-focus purposes — this covers
    /// all pending confirmation types.
    public private(set) var hasPendingConfirmation: Bool = false

    /// Whether any message contains non-empty text. Cached O(1) value so
    /// view bodies avoid O(n) scans.
    public private(set) var hasNonEmptyMessage: Bool = false

    /// The daemon message ID of the last persisted, non-streaming, non-hidden
    /// message. Cached O(1) value so view bodies avoid O(n) scans.
    public private(set) var latestPersistedTipDaemonMessageId: String?

    @ObservationIgnored private var derivedValuesSub: AnyCancellable?

    // MARK: - Combine publisher

    /// Publishes `messages` via a `CurrentValueSubject` for non-view consumers
    /// (pagination, voice mode, conversation manager, iOS store).
    @ObservationIgnored private let _messagesSubject = CurrentValueSubject<[ChatMessage], Never>([])
    public var messagesPublisher: AnyPublisher<[ChatMessage], Never> { _messagesSubject.eraseToAnyPublisher() }

    // MARK: - Deferred publish coalescing

    /// When non-nil, a pending task that will publish the current
    /// `_messagesStorage` snapshot. Created by `scheduleDeferredPublish()`
    /// from the `_modify` accessor so multiple rapid subscript mutations
    /// coalesce into a single downstream notification.
    @ObservationIgnored private var _deferredPublishTask: Task<Void, Never>?

    /// Schedule a single deferred Combine publish. If a task is already
    /// pending, this is a no-op — the existing task will publish the
    /// final snapshot after all synchronous mutations complete.
    ///
    /// The task runs on `@MainActor` via the cooperative executor, which
    /// drains during the run loop's source-processing phase — before
    /// SwiftUI's `CFRunLoopObserver` fires its transaction flush. This
    /// ensures derived values are up-to-date when views re-evaluate.
    private func scheduleDeferredPublish() {
        guard _deferredPublishTask == nil else { return }
        _deferredPublishTask = Task { @MainActor [weak self] in
            guard !Task.isCancelled, let self else { return }
            self._deferredPublishTask = nil
            self._messagesSubject.send(self._messagesStorage)
        }
    }

    // MARK: - Derived value recomputation

    /// Recomputes all cached derived values from a message snapshot in a
    /// single pass. Only writes to @Observable properties when the value
    /// actually changed, preventing unnecessary SwiftUI invalidation.
    ///
    /// Uses `visibleMessages` (all non-hidden) rather than paginated
    /// messages because pending confirmations are always near the end of
    /// the list, within the initial pagination window.
    private func recomputeDerivedValues(from messages: [ChatMessage]) {
        let visible = ChatVisibleMessageFilter.visibleMessages(from: messages)

        let newPendingId = PendingConfirmationFocusSelector.activeRequestId(from: visible)
        if newPendingId != activePendingRequestId { activePendingRequestId = newPendingId }

        let newHasPending = messages.contains { $0.confirmation?.state == .pending }
        if newHasPending != hasPendingConfirmation { hasPendingConfirmation = newHasPending }

        let newHasNonEmpty = messages.contains {
            !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        if newHasNonEmpty != hasNonEmptyMessage { hasNonEmptyMessage = newHasNonEmpty }

        let newTipId = messages.last {
            $0.daemonMessageId != nil && !$0.isStreaming && !$0.isHidden
        }?.daemonMessageId
        if newTipId != latestPersistedTipDaemonMessageId {
            latestPersistedTipDaemonMessageId = newTipId
        }
    }

    init() {
        // Subscribe once to recompute all derived values from each new
        // message snapshot. The single sink replaces four independent
        // Combine pipelines, reducing per-notification cost from 4×O(n)
        // to 1×O(n).
        derivedValuesSub = _messagesSubject
            .dropFirst() // skip the empty seed value
            .sink { [weak self] messages in
                self?.recomputeDerivedValues(from: messages)
            }
    }

    deinit {
        _deferredPublishTask?.cancel()
        derivedValuesSub?.cancel()
    }

    // MARK: - Input / send state

    public var inputText: String = ""

    /// Whether the assistant is in a "thinking" phase.
    public var isThinking: Bool = false
    public var isSending: Bool = false
    public var assistantActivityPhase: String = "idle"
    public var assistantActivityAnchor: String = "global"
    public var assistantActivityReason: String?
    public var assistantStatusText: String?
    public var isCompacting: Bool = false
    public var contextWindowTokens: Int? = nil
    public var contextWindowMaxTokens: Int? = nil
    /// Timestamp when auto-compaction will resume after the daemon's circuit
    /// breaker opened (3 consecutive summary-LLM failures). `nil` when the
    /// breaker is closed. UI surfaces a banner while this is non-nil and in
    /// the future.
    public var compactionCircuitOpenUntil: Date? = nil
    public var pendingQueuedCount: Int = 0
    /// Monotonic counter incremented once per successful main-turn completion
    /// (daemon `message_complete` event that isn't an auxiliary or cancel-ack).
    /// Observers watch this to fire end-of-turn side effects (e.g. the
    /// `task_complete` sound) without re-deriving state from transient flags
    /// that also flip between tool calls.
    public var turnCompletionTick: UInt64 = 0
    public var suggestion: String?
    public var isRecording: Bool = false
    public var recordingAmplitude: Float = 0

    // MARK: - Workspace refinement

    public var isWorkspaceRefinementInFlight: Bool = false
    /// The user's sent text shown while a refinement is in progress.
    public var refinementMessagePreview: String?
    /// The AI response as it streams during a refinement.
    public var refinementStreamingText: String?
    /// Tracks whether a cancel was initiated during a workspace refinement.
    /// Used by `messageComplete` to correctly suppress refinement side-effects
    /// even though `isWorkspaceRefinementInFlight` is cleared immediately for UI.
    @ObservationIgnored public var cancelledDuringRefinement: Bool = false
    /// Text buffered during a workspace refinement (normally suppressed from chat).
    /// Surfaced to the user if the refinement completes without a surface update.
    @ObservationIgnored public var refinementTextBuffer: String = ""
    @ObservationIgnored public var refinementReceivedSurfaceUpdate: Bool = false
    /// When non-nil, displays a toast in the workspace with the AI's response
    /// after a refinement that produced no surface update.
    public var refinementFailureText: String?
    @ObservationIgnored public var refinementFailureDismissTask: Task<Void, Never>?
    /// Coalesces refinement streaming text updates with a 50ms throttle,
    /// preventing republishing the entire accumulated buffer on every token.
    @ObservationIgnored public var refinementFlushTask: Task<Void, Never>?

    // MARK: - Surface / undo

    /// Number of undo steps available for the active workspace surface.
    public var surfaceUndoCount: Int = 0

    // MARK: - Skill / subagent

    public var pendingSkillInvocation: SkillInvocationData?
    public var isWatchSessionActive: Bool = false
    public var activeSubagents: [SubagentInfo] = []
    /// Widget IDs dismissed by the user, persisted across view recreation.
    public var dismissedDocumentSurfaceIds: Set<String> = []

    // MARK: - Model / provider

    /// The currently active model ID, updated via `model_info` messages.
    public var selectedModel: String = LLMProviderRegistry.defaultProvider?.defaultModel ?? ""
    /// Set of provider keys with configured API keys, updated via `model_info` messages.
    public var configuredProviders: Set<String> = ["anthropic"]
    /// Full provider catalog from daemon, updated via `model_info` messages.
    /// Seeded from `LLMProviderRegistry` so the UI has data before the first daemon fetch completes.
    public var providerCatalog: [ProviderCatalogEntry] = LLMProviderRegistry.providers.map(ProviderCatalogEntry.init(registryEntry:))

}

// MARK: - Registry bridging

extension ProviderCatalogEntry {
    /// Bridge a shared `LLMProviderEntry` (registry-sourced) into the wire-protocol
    /// `ProviderCatalogEntry` shape consumed by existing chat and settings code.
    /// Used to seed `providerCatalog` fields before the first daemon fetch completes.
    public init(registryEntry entry: LLMProviderEntry) {
        self.init(
            id: entry.id,
            displayName: entry.displayName,
            models: entry.models.map { CatalogModel(id: $0.id, displayName: $0.displayName) },
            defaultModel: entry.defaultModel,
            apiKeyUrl: entry.credentialsGuide?.url,
            apiKeyPlaceholder: entry.apiKeyPlaceholder
        )
    }
}

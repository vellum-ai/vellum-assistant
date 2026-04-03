import Combine
import Foundation
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
@MainActor @Observable
public final class ChatMessageManager {

    // MARK: - Message list

    /// The full message array. The custom getter/setter participates in the
    /// Observation framework (`access`/`withMutation`) while also pushing
    /// every mutation through `_messagesSubject` so Combine subscribers
    /// stay in sync.
    ///
    /// - SeeAlso: [Observation framework — custom properties](https://developer.apple.com/documentation/observation)
    public var messages: [ChatMessage] {
        get {
            access(keyPath: \.messages)
            return _messagesStorage
        }
        set {
            withMutation(keyPath: \.messages) {
                _messagesStorage = newValue
            }
            _messagesSubject.send(newValue)
        }
    }
    @ObservationIgnored private var _messagesStorage: [ChatMessage] = []

    /// Active pending confirmation request ID, derived from `messages` via a
    /// Combine pipeline. Views read this O(1) cached value instead of scanning
    /// the message array each render cycle.
    ///
    /// - SeeAlso: [Improving your app's performance (Apple Developer)](https://developer.apple.com/documentation/swiftui/improving-your-app-s-performance)
    /// - SeeAlso: [WWDC23 — Demystify SwiftUI performance](https://developer.apple.com/videos/play/wwdc2023/10160/)
    public private(set) var activePendingRequestId: String?

    /// Whether any message has a pending confirmation (including system
    /// permission requests). Cached O(1) value derived from `messages`.
    /// Unlike `activePendingRequestId` — which excludes
    /// `request_system_permission` for keyboard-focus purposes — this
    /// covers all pending confirmation types.
    public private(set) var hasPendingConfirmation: Bool = false

    /// Whether any message contains non-empty text. Cached O(1) value derived
    /// from `messages` via a Combine pipeline so view bodies avoid O(n) scans.
    public private(set) var hasNonEmptyMessage: Bool = false

    /// The daemon message ID of the last persisted, non-streaming, non-hidden
    /// message. Cached O(1) value derived from `messages` via a Combine pipeline
    /// so view bodies avoid O(n) scans.
    public private(set) var latestPersistedTipDaemonMessageId: String?

    @ObservationIgnored private var activePendingRequestIdSub: AnyCancellable?
    @ObservationIgnored private var hasPendingConfirmationSub: AnyCancellable?
    @ObservationIgnored private var hasNonEmptyMessageSub: AnyCancellable?
    @ObservationIgnored private var latestPersistedTipDaemonMessageIdSub: AnyCancellable?

    // MARK: - Combine publishers

    /// Publishes `messages` via a `CurrentValueSubject` for Combine subscribers
    /// (pagination, voice mode, conversation manager, iOS store).
    @ObservationIgnored private let _messagesSubject = CurrentValueSubject<[ChatMessage], Never>([])
    public var messagesPublisher: AnyPublisher<[ChatMessage], Never> { _messagesSubject.eraseToAnyPublisher() }

    /// Publishes `isThinking` via a `CurrentValueSubject` for Combine subscribers.
    @ObservationIgnored private let _isThinkingSubject = CurrentValueSubject<Bool, Never>(false)
    public var isThinkingPublisher: AnyPublisher<Bool, Never> { _isThinkingSubject.eraseToAnyPublisher() }

    init() {
        // Uses visibleMessages (all non-hidden) rather than paginatedMessages
        // because pending confirmations are always near the end of the list,
        // within the initial pagination window. The broader scope ensures the
        // model always knows the true pending state regardless of pagination.
        activePendingRequestIdSub = messagesPublisher
            .map { messages in
                PendingConfirmationFocusSelector.activeRequestId(
                    from: ChatVisibleMessageFilter.visibleMessages(from: messages)
                )
            }
            .removeDuplicates()
            .sink { [weak self] newValue in
                self?.activePendingRequestId = newValue
            }

        hasPendingConfirmationSub = messagesPublisher
            .map { messages in
                messages.contains { $0.confirmation?.state == .pending }
            }
            .removeDuplicates()
            .sink { [weak self] newValue in
                self?.hasPendingConfirmation = newValue
            }

        hasNonEmptyMessageSub = messagesPublisher
            .map { messages in
                messages.contains { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            }
            .removeDuplicates()
            .sink { [weak self] newValue in
                self?.hasNonEmptyMessage = newValue
            }

        latestPersistedTipDaemonMessageIdSub = messagesPublisher
            .map { messages in
                messages.last { $0.daemonMessageId != nil && !$0.isStreaming && !$0.isHidden }?.daemonMessageId
            }
            .removeDuplicates()
            .sink { [weak self] newValue in
                self?.latestPersistedTipDaemonMessageId = newValue
            }
    }

    // MARK: - Input / send state

    public var inputText: String = ""

    /// Whether the assistant is in a "thinking" phase. Like `messages`, the
    /// custom setter publishes directly to `_isThinkingSubject` so Combine
    /// subscribers stay in sync.
    public var isThinking: Bool {
        get {
            access(keyPath: \.isThinking)
            return _isThinkingStorage
        }
        set {
            withMutation(keyPath: \.isThinking) {
                _isThinkingStorage = newValue
            }
            _isThinkingSubject.send(newValue)
        }
    }
    @ObservationIgnored private var _isThinkingStorage: Bool = false
    public var isSending: Bool = false
    public var assistantActivityPhase: String = "idle"
    public var assistantActivityAnchor: String = "global"
    public var assistantActivityReason: String?
    public var assistantStatusText: String?
    public var isCompacting: Bool = false
    public var contextWindowTokens: Int? = nil
    public var contextWindowMaxTokens: Int? = nil
    public var pendingQueuedCount: Int = 0
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
    public var selectedModel: String = "claude-opus-4-6"
    /// Set of provider keys with configured API keys, updated via `model_info` messages.
    public var configuredProviders: Set<String> = ["anthropic"]
    /// Full provider catalog from daemon, updated via `model_info` messages.
    /// Seeded with inline defaults so the UI has data before the first daemon fetch completes.
    public var providerCatalog: [ProviderCatalogEntry] = ProviderCatalogEntry.defaultCatalog

}

// MARK: - Default Provider Catalog

extension ProviderCatalogEntry {
    /// Inline seed data shared by ChatMessageManager and SettingsStore so the
    /// model picker / model list has data before the first daemon fetch completes.
    public static let defaultCatalog: [ProviderCatalogEntry] = [
        ProviderCatalogEntry(id: "anthropic", displayName: "Anthropic", models: [
            CatalogModel(id: "claude-opus-4-6", displayName: "Claude Opus 4.6"),
            CatalogModel(id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6"),
            CatalogModel(id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5"),
        ], defaultModel: "claude-opus-4-6", apiKeyUrl: "https://console.anthropic.com/settings/keys", apiKeyPlaceholder: "sk-ant-api03-..."),
        ProviderCatalogEntry(id: "openai", displayName: "OpenAI", models: [
            CatalogModel(id: "gpt-5.4", displayName: "GPT-5.4"),
            CatalogModel(id: "gpt-5.2", displayName: "GPT-5.2"),
            CatalogModel(id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini"),
            CatalogModel(id: "gpt-5.4-nano", displayName: "GPT-5.4 Nano"),
        ], defaultModel: "gpt-5.4", apiKeyUrl: "https://platform.openai.com/api-keys", apiKeyPlaceholder: "sk-proj-..."),
        ProviderCatalogEntry(id: "gemini", displayName: "Google Gemini", models: [
            CatalogModel(id: "gemini-3-flash", displayName: "Gemini 3 Flash"),
            CatalogModel(id: "gemini-3-pro", displayName: "Gemini 3 Pro"),
        ], defaultModel: "gemini-3-flash", apiKeyUrl: "https://aistudio.google.com/apikey", apiKeyPlaceholder: "AIza..."),
        ProviderCatalogEntry(id: "ollama", displayName: "Ollama", models: [
            CatalogModel(id: "llama3.2", displayName: "Llama 3.2"),
            CatalogModel(id: "mistral", displayName: "Mistral"),
        ], defaultModel: "llama3.2"),
        ProviderCatalogEntry(id: "fireworks", displayName: "Fireworks", models: [
            CatalogModel(id: "accounts/fireworks/models/kimi-k2p5", displayName: "Kimi K2.5"),
        ], defaultModel: "accounts/fireworks/models/kimi-k2p5", apiKeyUrl: "https://fireworks.ai/account/api-keys", apiKeyPlaceholder: "fw_..."),
        ProviderCatalogEntry(id: "openrouter", displayName: "OpenRouter", models: [
            // xAI
            CatalogModel(id: "x-ai/grok-4.20-beta", displayName: "Grok 4.20 Beta"),
            CatalogModel(id: "x-ai/grok-4", displayName: "Grok 4"),
            // DeepSeek
            CatalogModel(id: "deepseek/deepseek-r1-0528", displayName: "DeepSeek R1"),
            CatalogModel(id: "deepseek/deepseek-chat-v3-0324", displayName: "DeepSeek V3"),
            // Qwen
            CatalogModel(id: "qwen/qwen3.5-plus-02-15", displayName: "Qwen 3.5 Plus"),
            CatalogModel(id: "qwen/qwen3.5-397b-a17b", displayName: "Qwen 3.5 397B"),
            CatalogModel(id: "qwen/qwen3.5-flash-02-23", displayName: "Qwen 3.5 Flash"),
            CatalogModel(id: "qwen/qwen3-coder-next", displayName: "Qwen 3 Coder"),
            // Moonshot
            CatalogModel(id: "moonshotai/kimi-k2.5", displayName: "Kimi K2.5"),
            // Mistral
            CatalogModel(id: "mistralai/mistral-medium-3", displayName: "Mistral Medium 3"),
            CatalogModel(id: "mistralai/mistral-small-2603", displayName: "Mistral Small 4"),
            CatalogModel(id: "mistralai/devstral-2512", displayName: "Devstral 2"),
            // Meta
            CatalogModel(id: "meta-llama/llama-4-maverick", displayName: "Llama 4 Maverick"),
            CatalogModel(id: "meta-llama/llama-4-scout", displayName: "Llama 4 Scout"),
            // Amazon
            CatalogModel(id: "amazon/nova-pro-v1", displayName: "Amazon Nova Pro"),
        ], defaultModel: "x-ai/grok-4.20-beta", apiKeyUrl: "https://openrouter.ai/keys", apiKeyPlaceholder: "sk-or-v1-..."),
    ]
}

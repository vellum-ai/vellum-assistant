import Foundation
import os
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#else
#error("Unsupported platform")
#endif

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ChatMessageManager")

/// Owns all message-list and send-state @Published properties that were previously
/// scattered across ChatViewModel.  ChatViewModel holds a reference to this object
/// and forwards reads/writes via computed properties so every existing call site
/// continues to compile without modification.
@MainActor
public final class ChatMessageManager: ObservableObject {

    // MARK: - Message list

    @Published public var messages: [ChatMessage] = []

    // MARK: - Input / send state

    @Published public var inputText: String = ""
    @Published public var isThinking: Bool = false
    @Published public var isSending: Bool = false
    @Published public var assistantActivityPhase: String = "idle"
    @Published public var assistantActivityAnchor: String = "global"
    @Published public var assistantActivityReason: String?
    @Published public var assistantStatusText: String?
    @Published public var isCompacting: Bool = false
    @Published public var pendingQueuedCount: Int = 0
    @Published public var suggestion: String?
    @Published public var isRecording: Bool = false
    @Published public var recordingAmplitude: Float = 0

    // MARK: - Workspace refinement

    @Published public var isWorkspaceRefinementInFlight: Bool = false
    /// The user's sent text shown while a refinement is in progress.
    @Published public var refinementMessagePreview: String?
    /// The AI response as it streams during a refinement.
    @Published public var refinementStreamingText: String?
    /// Tracks whether a cancel was initiated during a workspace refinement.
    /// Used by `messageComplete` to correctly suppress refinement side-effects
    /// even though `isWorkspaceRefinementInFlight` is cleared immediately for UI.
    public var cancelledDuringRefinement: Bool = false
    /// Text buffered during a workspace refinement (normally suppressed from chat).
    /// Surfaced to the user if the refinement completes without a surface update.
    public var refinementTextBuffer: String = ""
    public var refinementReceivedSurfaceUpdate: Bool = false
    /// When non-nil, displays a toast in the workspace with the AI's response
    /// after a refinement that produced no surface update.
    @Published public var refinementFailureText: String?
    public var refinementFailureDismissTask: Task<Void, Never>?
    /// Coalesces refinement streaming text updates with a 50ms throttle,
    /// preventing republishing the entire accumulated buffer on every token.
    public var refinementFlushTask: Task<Void, Never>?

    // MARK: - Surface / undo

    /// Number of undo steps available for the active workspace surface.
    @Published public var surfaceUndoCount: Int = 0

    // MARK: - Skill / subagent

    @Published public var pendingSkillInvocation: SkillInvocationData?
    @Published public var isWatchSessionActive: Bool = false
    @Published public var activeSubagents: [SubagentInfo] = []
    /// Widget IDs dismissed by the user, persisted across view recreation.
    @Published public var dismissedDocumentSurfaceIds: Set<String> = []

    // MARK: - Model / provider

    /// The currently active model ID, updated via `model_info` messages.
    @Published public var selectedModel: String = "claude-opus-4-6"
    /// Set of provider keys with configured API keys, updated via `model_info` messages.
    @Published public var configuredProviders: Set<String> = ["anthropic"]
    /// Full provider catalog from daemon, updated via `model_info` messages.
    /// Seeded with inline defaults so the UI has data before the first daemon fetch completes.
    @Published public var providerCatalog: [ProviderCatalogEntry] = ProviderCatalogEntry.defaultCatalog
    /// Masked API keys per provider from daemon (e.g. "sk-ant-api...Ab1x"), updated via `model_info` messages.
    @Published public var providerMaskedKeys: [String: String] = [:]

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
            CatalogModel(id: "x-ai/grok-4", displayName: "Grok 4"),
            CatalogModel(id: "x-ai/grok-4.20-beta", displayName: "Grok 4.20 Beta"),
        ], defaultModel: "x-ai/grok-4", apiKeyUrl: "https://openrouter.ai/keys", apiKeyPlaceholder: "sk-or-v1-..."),
    ]
}

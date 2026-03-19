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
    @Published public var providerCatalog: [ProviderCatalogEntry] = []

}

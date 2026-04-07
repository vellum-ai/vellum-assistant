import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ChatGreetingState")

/// Owns empty-state greeting and conversation starter properties that were
/// previously part of ChatViewModel.  ChatViewModel holds a reference to this
/// object and forwards reads/writes via computed properties so every existing
/// call site continues to compile without modification.
@MainActor
@Observable
public final class ChatGreetingState {

    // MARK: - Empty-State Greeting

    /// A daemon-generated greeting shown when the conversation is empty, or nil before generation.
    public var emptyStateGreeting: String? = nil
    /// True while a greeting is being streamed from the daemon.
    public var isGeneratingGreeting: Bool = false
    /// The in-flight greeting streaming task, stored for cancellation.
    @ObservationIgnored nonisolated(unsafe) var greetingTask: Task<Void, Never>?

    // MARK: - Conversation Starters

    /// Personalized suggestion chips shown on the empty conversation page.
    public var conversationStarters: [ConversationStarter] = []
    public var conversationStartersLoading: Bool = false

    @ObservationIgnored nonisolated(unsafe) var conversationStarterPollTask: Task<Void, Never>?

    // MARK: - Fallback Greetings

    static let fallbackGreetings = [
        "What are we working on?",
        "I'm here whenever you need me.",
        "What's on your mind?",
        "Let's make something happen.",
        "Ready when you are.",
    ]

    /// Maximum character length for a daemon-generated greeting before we
    /// fall back to a static greeting. The hero section renders greetings
    /// at `VFont.displayLarge` (32pt), so anything beyond a short phrase
    /// dominates the screen.
    private static let maxGreetingLength = 80

    // MARK: - Dependencies

    @ObservationIgnored private let btwClient: any BtwClientProtocol
    @ObservationIgnored private let conversationStarterClient: any ConversationStarterClientProtocol

    // MARK: - Init

    init(
        btwClient: any BtwClientProtocol = BtwClient(),
        conversationStarterClient: any ConversationStarterClientProtocol = ConversationStarterClient()
    ) {
        self.btwClient = btwClient
        self.conversationStarterClient = conversationStarterClient
    }

    // MARK: - Empty-State Greeting Generation

    /// Stream a short, personality-matched greeting from the daemon for the empty conversation state.
    /// Each call cancels any in-flight generation and starts fresh. On error, falls back to a
    /// random default greeting so the UI always receives a value.
    public func generateGreeting() {
        greetingTask?.cancel()
        emptyStateGreeting = nil
        isGeneratingGreeting = true

        greetingTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let key = "greeting"
            var result = ""
            do {
                let stream = self.btwClient.sendMessage(
                    content: "Generate a short, casual greeting in your voice from you to your user. This will be displayed when the user opens a new conversation (under 8 words). Match your personality. Output ONLY the greeting text — no quotes, no formatting.",
                    conversationKey: key
                )
                for try await delta in stream {
                    guard !Task.isCancelled else { return }
                    result += delta
                }
                guard !Task.isCancelled else { return }
                let trimmed = result.trimmingCharacters(in: .whitespacesAndNewlines)
                self.emptyStateGreeting = (trimmed.isEmpty || trimmed.count > Self.maxGreetingLength)
                    ? Self.fallbackGreetings.randomElement()!
                    : trimmed
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                self.emptyStateGreeting = Self.fallbackGreetings.randomElement()!
            }
            self.isGeneratingGreeting = false
        }
    }

    /// Clear greeting state and cancel any in-flight generation.
    public func dismissGreeting() {
        greetingTask?.cancel()
        greetingTask = nil
        emptyStateGreeting = nil
        isGeneratingGreeting = false
    }

    /// Fetch personalized conversation starters from the daemon for the empty conversation state.
    public func fetchConversationStarters() {
        conversationStarterPollTask?.cancel()
        conversationStarterPollTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let response = await self.conversationStarterClient.fetchConversationStarters(limit: 4)
            guard !Task.isCancelled else { return }

            if let response, !response.starters.isEmpty {
                self.conversationStarters = response.starters
                self.conversationStartersLoading = false
                return
            }

            if response?.status == "generating" {
                self.conversationStartersLoading = true
                // Poll every 3 seconds until ready
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    guard !Task.isCancelled else { return }
                    let poll = await self.conversationStarterClient.fetchConversationStarters(limit: 4)
                    guard !Task.isCancelled else { return }
                    if let poll, !poll.starters.isEmpty {
                        self.conversationStarters = poll.starters
                        self.conversationStartersLoading = false
                        return
                    }
                    if poll?.status != "generating" {
                        self.conversationStartersLoading = false
                        return
                    }
                }
            } else {
                self.conversationStartersLoading = false
            }
        }
    }

    /// Cancel all in-flight tasks. Called from ChatViewModel's nonisolated deinit.
    nonisolated public func cancelAll() {
        greetingTask?.cancel()
        conversationStarterPollTask?.cancel()
    }
}

import Foundation
import VellumAssistantShared
import Observation
import os

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "InterviewViewModel"
)

@Observable
@MainActor
final class InterviewViewModel {

    // MARK: - Public State

    var messages: [InterviewMessage] = []
    var inputText: String = ""
    var isThinking: Bool = false
    var isComplete: Bool = false
    var isFinished: Bool = false
    var streamingText: String = ""

    // MARK: - Dependencies

    private let daemonClient: DaemonClientProtocol
    private let assistantName: String

    // MARK: - Internal State

    private let maxTurns = 5
    private var conversationId: String?
    private var currentTask: Task<Void, Never>?
    private var startTime: Date?

    /// Number of completed assistant responses (greeting counts as turn 1).
    var turnCount: Int {
        messages.filter { $0.role == .assistant }.count
    }

    // MARK: - Init

    init(daemonClient: DaemonClientProtocol, assistantName: String) {
        self.daemonClient = daemonClient
        self.assistantName = assistantName
    }

    // MARK: - Start Interview

    /// Kicks off the interview by creating a new daemon text conversation in onboarding mode.
    /// The assistant-side playbook/prompt system owns the conversation intelligence.
    /// Captures the conversation ID and streams the assistant's opening reply into state.
    func startInterview() {
        startTime = Date()
        isThinking = true
        streamingText = ""

        currentTask?.cancel()
        currentTask = nil

        currentTask = Task { @MainActor [weak self] in
            guard let self else { return }

            let stream = self.daemonClient.subscribe()

            do {
                let trimmedName = self.assistantName.trimmingCharacters(in: .whitespacesAndNewlines)
                var hints = [
                    "onboarding-active",
                    "onboarding-phase:post_hatch",
                    "desktop-first-conversation"
                ]
                if !trimmedName.isEmpty {
                    hints.append("assistant-name:\(trimmedName)")
                }
                try self.daemonClient.send(ConversationCreateMessage(
                    title: "Getting to know you",
                    maxResponseTokens: 220,
                    transportChannelId: "vellum",
                    transportHints: hints,
                    transportUxBrief: "Onboarding conversation after hatch. Follow the channel playbook and update USER.md directly."
                ))
            } catch {
                log.error("Failed to send conversation create: \(error.localizedDescription)")
                self.isThinking = false
                self.messages.append(InterviewMessage(
                    role: .assistant,
                    text: "I'm having trouble connecting. Please try again in a moment."
                ))
                return
            }

            var accumulated = ""

            for await message in stream {
                guard !Task.isCancelled else { break }

                switch message {
                case .conversationInfo(let info):
                    // Capture the daemon-assigned conversation ID, then send a natural
                    // first user message to kick off the conversation.
                    if self.conversationId == nil {
                        self.conversationId = info.conversationId
                        log.info("Interview conversation created: \(info.conversationId)")

                        do {
                            try self.daemonClient.send(UserMessageMessage(
                                conversationId: info.conversationId,
                                content: "Hi! I just hatched you and I want to get set up together.",
                                attachments: nil
                            ))
                        } catch {
                            log.error("Failed to send initial message: \(error.localizedDescription)")
                            self.isThinking = false
                            self.messages.append(InterviewMessage(
                                role: .assistant,
                                text: "I'm having trouble connecting. Please try again in a moment."
                            ))
                            return
                        }
                    }

                case .assistantTextDelta(let delta) where self.conversationId != nil:
                    accumulated += delta.text
                    self.isThinking = false
                    self.streamingText = accumulated

                case .assistantThinkingDelta where self.conversationId != nil:
                    // Stay in thinking state while the model reasons.
                    break

                case .messageComplete(let complete) where complete.conversationId == self.conversationId && self.conversationId != nil:
                    self.isThinking = false
                    self.streamingText = ""
                    let finalText = accumulated.isEmpty ? "(No response)" : accumulated
                    self.messages.append(InterviewMessage(
                        role: .assistant,
                        text: finalText
                    ))
                    log.info("Interview greeting complete (\(accumulated.count) chars)")
                    return

                case .generationHandoff(let handoff) where handoff.conversationId == self.conversationId && self.conversationId != nil:
                    self.isThinking = false
                    self.streamingText = ""
                    let finalText = accumulated.isEmpty ? "(No response)" : accumulated
                    self.messages.append(InterviewMessage(
                        role: .assistant,
                        text: finalText
                    ))
                    log.info("Interview greeting complete via handoff (\(accumulated.count) chars)")
                    return

                case .conversationError(let error) where error.conversationId == self.conversationId && self.conversationId != nil:
                    self.isThinking = false
                    self.streamingText = ""
                    log.error("Interview start failed (conversation_error): \(error.userMessage)")
                    self.messages.append(InterviewMessage(
                        role: .assistant,
                        text: "I'm having trouble connecting. Please try again in a moment."
                    ))
                    return

                default:
                    break
                }
            }

            // Stream ended without a terminal message.
            if !Task.isCancelled {
                self.isThinking = false
                self.streamingText = ""
                if !accumulated.isEmpty {
                    self.messages.append(InterviewMessage(
                        role: .assistant,
                        text: accumulated
                    ))
                }
            }
        }
    }

    // MARK: - Send Follow-up Message

    /// Sends a follow-up user message within the existing interview conversation.
    /// Subscribes to the daemon stream and listens for the assistant's streamed reply
    /// rather than creating a new conversation, keeping the conversation context intact.
    func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isFinished else { return }
        guard let conversationId else {
            log.warning("Cannot send message — no active conversation")
            return
        }

        // Append user message immediately.
        messages.append(InterviewMessage(role: .user, text: text))
        inputText = ""
        isThinking = true
        streamingText = ""

        let nextTurn = turnCount + 1 // the response about to be generated
        let contentToSend = text

        let isLastTurn = nextTurn >= maxTurns

        currentTask?.cancel()
        currentTask = nil

        currentTask = Task { @MainActor [weak self] in
            guard let self else { return }

            let stream = self.daemonClient.subscribe()

            do {
                try self.daemonClient.send(UserMessageMessage(
                    conversationId: conversationId,
                    content: contentToSend,
                    attachments: nil
                ))
            } catch {
                log.error("Failed to send user message: \(error.localizedDescription)")
                self.isThinking = false
                self.messages.append(InterviewMessage(
                    role: .assistant,
                    text: "Sorry, I couldn't send that message. Please try again."
                ))
                return
            }

            var accumulated = ""

            for await message in stream {
                guard !Task.isCancelled else { break }

                switch message {
                case .assistantTextDelta(let delta):
                    accumulated += delta.text
                    self.isThinking = false
                    self.streamingText = accumulated

                case .assistantThinkingDelta:
                    // Stay in thinking state while the model reasons.
                    break

                case .messageComplete(let complete) where complete.conversationId == conversationId:
                    self.isThinking = false
                    self.streamingText = ""
                    let finalText = accumulated.isEmpty ? "(No response)" : accumulated
                    self.messages.append(InterviewMessage(
                        role: .assistant,
                        text: finalText
                    ))
                    if isLastTurn {
                        self.isFinished = true
                    }
                    log.info("Follow-up response complete (\(accumulated.count) chars)")
                    return

                case .generationHandoff(let handoff) where handoff.conversationId == conversationId:
                    self.isThinking = false
                    self.streamingText = ""
                    let finalText = accumulated.isEmpty ? "(No response)" : accumulated
                    self.messages.append(InterviewMessage(
                        role: .assistant,
                        text: finalText
                    ))
                    if isLastTurn {
                        self.isFinished = true
                    }
                    log.info("Follow-up response complete via handoff (\(accumulated.count) chars)")
                    return

                case .conversationError(let error) where error.conversationId == conversationId:
                    self.isThinking = false
                    self.streamingText = ""
                    log.error("Conversation error during follow-up (conversation_error): \(error.userMessage)")
                    self.messages.append(InterviewMessage(
                        role: .assistant,
                        text: "Something went wrong. Please try again."
                    ))
                    return

                default:
                    break
                }
            }

            // Stream ended without a terminal message.
            if !Task.isCancelled {
                self.isThinking = false
                self.streamingText = ""
                if !accumulated.isEmpty {
                    self.messages.append(InterviewMessage(
                        role: .assistant,
                        text: accumulated
                    ))
                }
            }
        }
    }

    // MARK: - End Interview

    /// Marks the interview as complete and cancels any in-progress streaming.
    func endInterview() {
        if let startTime {
            let duration = Date().timeIntervalSince(startTime)
            let turns = self.turnCount
            let finished = self.isFinished
            log.info("Interview completed: turns=\(turns), finished=\(finished), duration=\(String(format: "%.1f", duration))s")
        }

        isComplete = true
        currentTask?.cancel()
        currentTask = nil
        conversationId = nil
        isThinking = false
        streamingText = ""
    }

    // MARK: - Cancel

    /// Cancels any in-progress daemon communication task.
    func cancel() {
        currentTask?.cancel()
        currentTask = nil
        conversationId = nil
    }
}

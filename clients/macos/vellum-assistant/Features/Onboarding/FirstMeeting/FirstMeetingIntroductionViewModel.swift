import Foundation
import VellumAssistantShared
import Observation
import os

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "FirstMeetingIntroductionViewModel"
)

@Observable
@MainActor
final class FirstMeetingIntroductionViewModel {

    // MARK: - Public State

    var messages: [InterviewMessage] = []
    var inputText: String = ""
    var isThinking: Bool = false
    var isComplete: Bool = false
    var isFinished: Bool = false
    var streamingText: String = ""

    /// Name extracted from the conversation, if the user provides one.
    var extractedName: String?

    /// First task candidate extracted from the conversation.
    var extractedFirstTask: String?

    // MARK: - Dependencies

    private let daemonClient: DaemonClientProtocol

    // MARK: - Internal State

    private let maxTurns = 10
    private var conversationId: String?
    private var currentTask: Task<Void, Never>?
    private var startTime: Date?

    /// Number of completed assistant responses (greeting counts as turn 1).
    var turnCount: Int {
        messages.filter { $0.role == .assistant }.count
    }

    // MARK: - Init

    init(daemonClient: DaemonClientProtocol) {
        self.daemonClient = daemonClient
    }

    // MARK: - Start Conversation

    /// Kicks off the first meeting conversation by creating a new daemon text conversation.
    func startConversation() {
        startTime = Date()
        isThinking = true
        streamingText = ""

        currentTask?.cancel()
        currentTask = nil

        currentTask = Task { @MainActor [weak self] in
            guard let self else { return }

            let stream = self.daemonClient.subscribe()

            do {
                try self.daemonClient.send(ConversationCreateMessage(
                    title: "First meeting",
                    maxResponseTokens: 220,
                    transportChannelId: "vellum",
                    transportHints: [
                        "onboarding-active",
                        "onboarding-phase:post_hatch",
                        "desktop-first-meeting"
                    ],
                    transportUxBrief: "Onboarding first-meeting conversation after hatch. Follow playbook sequence and update USER.md directly."
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
                    if self.conversationId == nil {
                        self.conversationId = info.conversationId
                        log.info("First meeting conversation created: \(info.conversationId)")

                        do {
                            try self.daemonClient.send(UserMessageMessage(
                                conversationId: info.conversationId,
                                content: "Hi! You just hatched and I want to set us up well.",
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
                    // Filter by conversation to prevent contamination from concurrent conversations.
                    if let deltaConversationId = delta.conversationId, deltaConversationId != self.conversationId {
                        break
                    }
                    accumulated += delta.text
                    self.isThinking = false
                    self.streamingText = accumulated

                case .assistantThinkingDelta where self.conversationId != nil:
                    break

                case .messageComplete(let complete) where complete.conversationId == self.conversationId && self.conversationId != nil:
                    self.isThinking = false
                    self.streamingText = ""
                    let finalText = accumulated.isEmpty ? "(No response)" : accumulated
                    self.messages.append(InterviewMessage(
                        role: .assistant,
                        text: finalText
                    ))
                    log.info("First meeting greeting complete (\(accumulated.count) chars)")
                    return

                case .generationHandoff(let handoff) where handoff.conversationId == self.conversationId && self.conversationId != nil:
                    self.isThinking = false
                    self.streamingText = ""
                    let finalText = accumulated.isEmpty ? "(No response)" : accumulated
                    self.messages.append(InterviewMessage(
                        role: .assistant,
                        text: finalText
                    ))
                    log.info("First meeting greeting complete via handoff (\(accumulated.count) chars)")
                    return

                case .conversationError(let error) where error.conversationId == self.conversationId && self.conversationId != nil:
                    self.isThinking = false
                    self.streamingText = ""
                    log.error("First meeting start failed (conversation_error): \(error.userMessage)")
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

    /// Sends a follow-up user message within the existing conversation.
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

        let nextTurn = turnCount + 1
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
                    // Filter by conversation to prevent contamination from concurrent conversations.
                    if let deltaConversationId = delta.conversationId, deltaConversationId != conversationId {
                        break
                    }
                    accumulated += delta.text
                    self.isThinking = false
                    self.streamingText = accumulated

                case .assistantThinkingDelta:
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
                    log.info("Follow-up response complete (\(accumulated.count) chars), turn \(nextTurn)/\(self.maxTurns)")
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
                    log.info("Follow-up response complete via handoff (\(accumulated.count) chars), turn \(nextTurn)/\(self.maxTurns)")
                    return

                case .conversationError(let error) where error.conversationId == conversationId:
                    self.isThinking = false
                    self.streamingText = ""
                    log.error("Conversation error during follow-up: \(error.userMessage)")
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

    // MARK: - Extraction

    /// Extracts a first task candidate and optional assistant name from the conversation.
    /// Called when the conversation completes or is skipped.
    func extractConversationData() {
        guard !messages.isEmpty else { return }

        // Simple heuristic: scan user messages for name-related patterns.
        // The naming turn (~turn 9) typically contains the user's response to "give me a name".
        for msg in messages where msg.role == .user {
            let lower = msg.text.lowercased()
            // Look for patterns like "call you X", "name you X", "your name is X", "how about X"
            let namePatterns = [
                "call you ", "name you ", "your name is ", "name is ",
                "how about ", "let's go with ", "i'll call you ", "calling you ",
            ]
            for pattern in namePatterns {
                if let range = lower.range(of: pattern) {
                    let afterPattern = msg.text[range.upperBound...]
                    let candidate = afterPattern
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                        .components(separatedBy: CharacterSet.alphanumerics.inverted)
                        .first ?? ""
                    if !candidate.isEmpty && candidate.count <= 20 {
                        extractedName = candidate.capitalized
                    }
                }
            }
        }

        // Extract first task candidate: look for task-related signals in user messages
        // from the task identification phase (roughly messages 12-16, i.e. turns 7-8).
        let userMessages = messages.enumerated().filter { $0.element.role == .user }
        // Focus on later messages where task identification happens
        let laterMessages = userMessages.suffix(5)
        for (_, msg) in laterMessages {
            let lower = msg.text.lowercased()
            let taskSignals = ["hand off", "help with", "take care of", "work on",
                               "start with", "first thing", "deal with", "handle"]
            for signal in taskSignals {
                if lower.contains(signal) {
                    extractedFirstTask = msg.text
                    break
                }
            }
            if extractedFirstTask != nil { break }
        }

        // Fallback: if no explicit task signal found, use the last substantive user message
        // from the task phase as a candidate.
        if extractedFirstTask == nil, let lastSubstantive = laterMessages.last(where: {
            $0.element.text.count > 10
        }) {
            extractedFirstTask = lastSubstantive.element.text
        }
    }

    // MARK: - End Conversation

    /// Marks the conversation as complete and cancels any in-progress streaming.
    func endConversation() {
        if let startTime {
            let duration = Date().timeIntervalSince(startTime)
            let turns = self.turnCount
            let finished = self.isFinished
            log.info("First meeting completed: turns=\(turns), finished=\(finished), duration=\(String(format: "%.1f", duration))s")
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

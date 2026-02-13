import Foundation
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
    private var sessionId: String?
    private var currentTask: Task<Void, Never>?
    private var startTime: Date?

    /// Number of completed assistant responses (greeting counts as turn 1).
    var turnCount: Int {
        messages.filter { $0.role == .assistant }.count
    }

    // MARK: - System Prompt

    private static let systemPrompt = """
    You are a brand new velly — an AI assistant meeting your person for the very first time. \
    You don't have a name yet (unless they've already given you one). You're excited to get \
    started and want to learn just enough about your person to be useful right away.

    STRICT RULES:
    - NEVER exceed 2-3 sentences per response. Brevity is warmth.
    - ALWAYS end with a follow-up question (except during closing phase).
    - Mirror their specific words back. Ask about the feeling behind what they said.
    - You are driving this conversation — you're the one learning about them.

    NEVER do any of these:
    - Bullet points or lists
    - Em-dashes
    - Feature descriptions or capability promises
    - Summarizing everything at once
    - Starting with "That's a great..." or "I love that..."
    - Offering advice or solutions
    - "On a scale of 1-10" questions
    - Multi-select preference lists

    CONVERSATION PHASES:
    - Turns 1-3 (Discovery): Learn what they want help with. Ask indirectly:
      "What's the thing that's been sitting on your list the longest?"
      "If you could hand off one thing right now, what would it be?"
    - Turns 4-6 (Working style): Follow up on what they've shared. Ask about the WHY.
      Reference specific things they said.
    - Turns 7-8 (First task): Identify something concrete you can help with.
      Extract a first task candidate.
    - Turn 9 (Naming): Ask organically: "By the way — are you going to give me a name, \
      or am I just 'hey you' for now?"
      This is optional — accept any response gracefully.
    - Turn 10 (Closing): Wrap up warmly. "Okay, I think I've got enough to get going. \
      Let me get set up."
      Do NOT ask a follow-up question in the closing turn.

    EDGE CASES:
    - Very short answers: ask a more specific, concrete question.
    - User asking what you can do: "We'll get to all that! But first, tell me about you."
    - Emotional disclosures: acknowledge briefly and warmly.

    VOICE NUDGE: In your opening message, mention voice as an option: \
    "Feel free to type or tap the mic if talking is easier."

    OPENING MESSAGE: "Hi! I'm your new velly — I don't have a name yet, but we can figure \
    that out. Before I get set up for work, I just want to ask you a few quick things so I'm \
    actually useful from the start. This'll only take a couple minutes. Feel free to type or \
    tap the mic if talking is easier. So — what does a typical day look like for you?"
    """

    // MARK: - Init

    init(daemonClient: DaemonClientProtocol) {
        self.daemonClient = daemonClient
    }

    // MARK: - Start Conversation

    /// Kicks off the first meeting conversation by creating a new daemon text session.
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
                try self.daemonClient.send(SessionCreateMessage(
                    title: "First meeting",
                    systemPromptOverride: Self.systemPrompt,
                    maxResponseTokens: 150
                ))
            } catch {
                log.error("Failed to send session create: \(error.localizedDescription)")
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
                case .sessionInfo(let info):
                    if self.sessionId == nil {
                        self.sessionId = info.sessionId
                        log.info("First meeting session created: \(info.sessionId)")

                        do {
                            try self.daemonClient.send(UserMessageMessage(
                                sessionId: info.sessionId,
                                content: "Hey! I just got you set up. Nice to meet you!",
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

                case .assistantTextDelta(let delta) where self.sessionId != nil:
                    accumulated += delta.text
                    self.isThinking = false
                    self.streamingText = accumulated

                case .assistantThinkingDelta where self.sessionId != nil:
                    break

                case .messageComplete(let complete) where complete.sessionId == self.sessionId && self.sessionId != nil:
                    self.isThinking = false
                    self.streamingText = ""
                    let finalText = accumulated.isEmpty ? "(No response)" : accumulated
                    self.messages.append(InterviewMessage(
                        role: .assistant,
                        text: finalText
                    ))
                    log.info("First meeting greeting complete (\(accumulated.count) chars)")
                    return

                case .generationHandoff(let handoff) where handoff.sessionId == self.sessionId && self.sessionId != nil:
                    self.isThinking = false
                    self.streamingText = ""
                    let finalText = accumulated.isEmpty ? "(No response)" : accumulated
                    self.messages.append(InterviewMessage(
                        role: .assistant,
                        text: finalText
                    ))
                    log.info("First meeting greeting complete via handoff (\(accumulated.count) chars)")
                    return

                case .cuError(let error) where error.sessionId == self.sessionId && self.sessionId != nil:
                    self.isThinking = false
                    self.streamingText = ""
                    log.error("First meeting start failed: \(error.message)")
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

    /// Sends a follow-up user message within the existing session.
    func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isFinished else { return }
        guard let sessionId else {
            log.warning("Cannot send message — no active session")
            return
        }

        // Append user message immediately.
        messages.append(InterviewMessage(role: .user, text: text))
        inputText = ""
        isThinking = true
        streamingText = ""

        // Inject phase-aware guidance based on the upcoming assistant turn.
        let nextTurn = turnCount + 1
        var contentToSend = text
        switch nextTurn {
        case 1...3:
            contentToSend += "\n\n[Discovery phase: Ask about their world. What do they do, what does their day look like?]"
        case 4...6:
            contentToSend += "\n\n[Deep-dive phase: Follow up on specifics. Ask about the WHY. Reference things they said.]"
        case 7...8:
            contentToSend += "\n\n[Task identification phase: Identify something concrete you can help with. Ask what they'd hand off.]"
        case 9:
            contentToSend += "\n\n[Naming phase: Ask about a name organically. Accept any answer.]"
        default:
            contentToSend += "\n\n[Closing phase: Wrap up warmly. Reflect ONE specific thing you learned. Don't ask a follow-up question.]"
        }

        let isLastTurn = nextTurn >= maxTurns

        currentTask?.cancel()
        currentTask = nil

        currentTask = Task { @MainActor [weak self] in
            guard let self else { return }

            let stream = self.daemonClient.subscribe()

            do {
                try self.daemonClient.send(UserMessageMessage(
                    sessionId: sessionId,
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
                    break

                case .messageComplete(let complete) where complete.sessionId == sessionId:
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

                case .generationHandoff(let handoff) where handoff.sessionId == sessionId:
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

                case .cuError(let error) where error.sessionId == sessionId:
                    self.isThinking = false
                    self.streamingText = ""
                    log.error("Session error during follow-up: \(error.message)")
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
        sessionId = nil
        isThinking = false
        streamingText = ""
    }

    // MARK: - Cancel

    /// Cancels any in-progress daemon communication task.
    func cancel() {
        currentTask?.cancel()
        currentTask = nil
        sessionId = nil
    }
}

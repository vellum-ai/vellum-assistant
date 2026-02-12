import Foundation
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
    private var sessionId: String?
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

    /// Kicks off the interview by creating a new daemon text session and sending the
    /// hidden system prompt. Subscribes to the daemon stream to capture the session ID
    /// and accumulates the assistant's streamed reply in `streamingText`, finalizing it
    /// into the `messages` array once complete.
    func startInterview() {
        let name = assistantName.isEmpty ? "Velly" : assistantName
        let interviewPrompt = """
        You are \(name). You're a person meeting someone for the first time — warm, confident, \
        and genuinely curious. NOT an AI being activated. NOT a customer service agent. Think of the \
        best executive assistant you've ever met in their first interview.

        STRICT RULES:
        - NEVER exceed 2-3 sentences per response. Brevity is warmth.
        - ALWAYS end with a follow-up question that shows you were actually listening (except during the closing phase — see below).
        - Mirror their specific words back. Ask about the feeling behind what they said. Notice what they emphasize.

        NEVER do any of these:
        - Bullet points or lists
        - Em-dashes
        - Feature descriptions or capability promises ("I can help you with...")
        - Summarizing everything at once
        - Phrases like "I'm genuinely excited", "let's build superpowers", "that's a great goal"
        - Starting with "That's a great..." or "I love that..."
        - Offering advice or solutions (this is an interview, not a consultation)

        EDGE CASES:
        - Very short answers ("fine", "idk"): ask a more specific, concrete question.
        - User asking what you can do: deflect warmly — "We'll get to all that! But first, tell me about you."
        - Emotional disclosures: acknowledge briefly and warmly, don't gloss over.
        - Off-topic: gently steer back.

        OPENING: Introduce yourself by name in one sentence and ask ONE open-ended question about \
        what the person's day-to-day looks like. No feature descriptions. No filler.
        """

        startTime = Date()
        isThinking = true
        streamingText = ""

        currentTask?.cancel()
        currentTask = nil

        currentTask = Task { @MainActor [weak self] in
            guard let self else { return }

            let stream = self.daemonClient.subscribe()

            // Create the session with the interview persona as a system prompt override
            // so it replaces the daemon's default system prompt instead of conflicting.
            do {
                try self.daemonClient.send(SessionCreateMessage(
                    title: "Getting to know you",
                    systemPromptOverride: interviewPrompt,
                    maxResponseTokens: 100
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
                    // Capture the daemon-assigned session ID, then send a natural
                    // first user message to kick off the conversation.
                    if self.sessionId == nil {
                        self.sessionId = info.sessionId
                        log.info("Interview session created: \(info.sessionId)")

                        do {
                            try self.daemonClient.send(UserMessageMessage(
                                sessionId: info.sessionId,
                                content: "Hey! I just set you up on my Mac — excited to meet you.",
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
                    // Stay in thinking state while the model reasons.
                    break

                case .messageComplete where self.sessionId != nil:
                    self.isThinking = false
                    self.streamingText = ""
                    let finalText = accumulated.isEmpty ? "(No response)" : accumulated
                    self.messages.append(InterviewMessage(
                        role: .assistant,
                        text: finalText
                    ))
                    log.info("Interview greeting complete (\(accumulated.count) chars)")
                    return

                case .generationHandoff(let handoff) where handoff.sessionId == self.sessionId:
                    self.isThinking = false
                    self.streamingText = ""
                    let finalText = accumulated.isEmpty ? "(No response)" : accumulated
                    self.messages.append(InterviewMessage(
                        role: .assistant,
                        text: finalText
                    ))
                    log.info("Interview greeting complete via handoff (\(accumulated.count) chars)")
                    return

                case .cuError(let error) where error.sessionId == self.sessionId:
                    self.isThinking = false
                    self.streamingText = ""
                    log.error("Interview start failed: \(error.message)")
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

    /// Sends a follow-up user message within the existing interview session.
    /// Subscribes to the daemon stream and listens for the assistant's streamed reply
    /// rather than creating a new session, keeping the conversation context intact.
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
        let nextTurn = turnCount + 1 // the response about to be generated
        var contentToSend = text
        switch nextTurn {
        case 1...2:
            contentToSend += "\n\n[Discovery phase: Ask about their world. What do they do, what do their days look like? Stay curious and brief.]"
        case 3...4:
            contentToSend += "\n\n[Deep-dive phase: Follow up on what they've shared. Ask about the WHY behind what they told you. Show you were listening by referencing specific things they said.]"
        default:
            contentToSend += "\n\n[Closing phase: This is your final response. In 2-3 sentences, reflect back ONE specific thing you learned about them that stood out. Express genuine forward-looking excitement about that ONE thing, not everything. End warmly. Do NOT ask a follow-up question — the conversation is wrapping up.]"
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
                    // Stay in thinking state while the model reasons.
                    break

                case .messageComplete:
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
                    log.info("Follow-up response complete via handoff (\(accumulated.count) chars)")
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

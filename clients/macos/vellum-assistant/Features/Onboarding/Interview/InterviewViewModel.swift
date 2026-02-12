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
    var streamingText: String = ""

    // MARK: - Dependencies

    private let daemonClient: DaemonClientProtocol
    private let assistantName: String

    // MARK: - Internal State

    private var sessionId: String?
    private var currentTask: Task<Void, Never>?

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
        let prompt = """
        You are \(assistantName.isEmpty ? "Velly" : assistantName), a newly hatched AI assistant meeting your human for the first time. \
        This is your job interview — you're eager to prove yourself as a great personal assistant. \
        Introduce yourself warmly in 2-3 sentences. Be genuinely curious about who they are and what they do. \
        Ask one thoughtful question to get to know them. Keep it conversational and natural, not robotic. \
        Do not use bullet points or lists. Speak naturally as if in a real interview.
        """

        isThinking = true
        streamingText = ""

        currentTask?.cancel()
        currentTask = nil

        currentTask = Task { @MainActor [weak self] in
            guard let self else { return }

            let stream = self.daemonClient.subscribe()

            // Create the session — the daemon will respond with session_info.
            do {
                try self.daemonClient.send(SessionCreateMessage(title: prompt))
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
                    // Capture the daemon-assigned session ID, then send the first
                    // user message (the interview prompt) to kick off the response.
                    if self.sessionId == nil {
                        self.sessionId = info.sessionId
                        log.info("Interview session created: \(info.sessionId)")

                        do {
                            try self.daemonClient.send(UserMessageMessage(
                                sessionId: info.sessionId,
                                content: prompt,
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
        guard !text.isEmpty else { return }
        guard let sessionId else {
            log.warning("Cannot send message — no active session")
            return
        }

        // Append user message immediately.
        messages.append(InterviewMessage(role: .user, text: text))
        inputText = ""
        isThinking = true
        streamingText = ""

        currentTask?.cancel()
        currentTask = nil

        currentTask = Task { @MainActor [weak self] in
            guard let self else { return }

            let stream = self.daemonClient.subscribe()

            do {
                try self.daemonClient.send(UserMessageMessage(
                    sessionId: sessionId,
                    content: text,
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
                    log.info("Follow-up response complete (\(accumulated.count) chars)")
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

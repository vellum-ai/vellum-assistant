import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "TextSession")

enum TextSessionState: Equatable {
    case idle
    case thinking
    case streaming(text: String)
    case completed(text: String)
    case failed(reason: String)
    case cancelled
}

@MainActor
final class TextSession: ObservableObject {
    @Published var state: TextSessionState = .idle
    let task: String
    let id: String

    private let attachments: [TaskAttachment]
    private let daemonClient: DaemonClientProtocol
    private var isCancelled = false
    private var messageLoopTask: Task<Void, Never>?
    private var daemonSessionId: String?
    private var accumulatedText: String = ""
    private var externalStream: AsyncStream<ServerMessage>?

    init(
        sessionId: String,
        task: String,
        daemonClient: DaemonClientProtocol,
        attachments: [TaskAttachment] = [],
        messageStream: AsyncStream<ServerMessage>? = nil
    ) {
        self.id = sessionId
        self.task = task
        self.attachments = attachments
        self.daemonClient = daemonClient
        self.daemonSessionId = sessionId
        self.externalStream = messageStream
    }

    func run() async {
        isCancelled = false
        accumulatedText = ""
        state = .thinking

        log.info("TextSession starting — task: \(self.task, privacy: .public), sessionId: \(self.id)")

        // Use provided stream (which already captured early deltas) or subscribe fresh
        let messageStream = externalStream ?? daemonClient.subscribe()

        let loopTask = Task { @MainActor [weak self] in
            guard let self else { return }

            for await message in messageStream {
                guard !self.isCancelled else { break }

                switch message {
                case .assistantTextDelta(let delta):
                    self.accumulatedText += delta.text
                    self.state = .streaming(text: self.accumulatedText)

                case .assistantThinkingDelta(let delta):
                    log.debug("Thinking: \(delta.thinking)")

                case .messageComplete:
                    if self.accumulatedText.isEmpty {
                        self.state = .completed(text: "(No response)")
                    } else {
                        self.state = .completed(text: self.accumulatedText)
                    }
                    return

                case .cuError(let error) where error.sessionId == self.daemonSessionId:
                    self.state = .failed(reason: error.message)
                    return

                default:
                    break
                }
            }
        }
        messageLoopTask = loopTask
        await loopTask.value

        // Stream ended or cancelled — ensure terminal state
        switch state {
        case .completed, .failed, .cancelled:
            break
        default:
            if isCancelled {
                state = .cancelled
            } else {
                state = .failed(reason: "Connection to daemon lost")
            }
        }
    }

    func cancel() {
        isCancelled = true
        messageLoopTask?.cancel()
    }
}

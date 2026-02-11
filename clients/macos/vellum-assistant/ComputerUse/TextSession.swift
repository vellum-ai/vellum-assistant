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
    private let skipSessionCreate: Bool
    private let existingStream: AsyncStream<ServerMessage>?
    private var isCancelled = false
    private var messageLoopTask: Task<Void, Never>?
    private var daemonSessionId: String?
    private var accumulatedText: String = ""

    init(
        task: String,
        daemonClient: DaemonClientProtocol,
        attachments: [TaskAttachment] = [],
        sessionId: String? = nil,
        skipSessionCreate: Bool = false,
        existingStream: AsyncStream<ServerMessage>? = nil
    ) {
        self.id = sessionId ?? UUID().uuidString
        self.task = task
        self.attachments = attachments
        self.daemonClient = daemonClient
        self.skipSessionCreate = skipSessionCreate
        self.existingStream = existingStream
    }

    func run() async {
        isCancelled = false
        accumulatedText = ""
        state = .thinking

        log.info("TextSession starting — task: \(self.task, privacy: .public)")

        // Use existing stream (from task_submit flow) or subscribe fresh
        let messageStream: AsyncStream<ServerMessage>
        if skipSessionCreate {
            // Daemon already created the session and started streaming
            daemonSessionId = id
            messageStream = existingStream ?? daemonClient.subscribe()
        } else {
            daemonSessionId = nil
            messageStream = daemonClient.subscribe()
            try? daemonClient.send(SessionCreateMessage(title: task))
        }

        // Listen for messages
        let loopTask = Task { @MainActor [weak self] in
            guard let self else { return }

            for await message in messageStream {
                guard !self.isCancelled else { break }

                switch message {
                case .sessionInfo(let info):
                    // Accept first session_info as ours (daemon assigns session ID)
                    if self.daemonSessionId == nil {
                        self.daemonSessionId = info.sessionId
                        log.info("Got daemon session ID: \(info.sessionId)")

                        // Now send the user message
                        let ipcAttachments: [IPCAttachment]? = self.attachments.isEmpty ? nil : self.attachments.map {
                            IPCAttachment(
                                filename: $0.fileName,
                                mimeType: $0.mimeType,
                                data: $0.data.base64EncodedString(),
                                extractedText: $0.extractedText
                            )
                        }
                        try? self.daemonClient.send(UserMessageMessage(
                            sessionId: info.sessionId,
                            content: self.task,
                            attachments: ipcAttachments
                        ))
                    }

                case .assistantTextDelta(let delta) where self.daemonSessionId != nil:
                    self.accumulatedText += delta.text
                    self.state = .streaming(text: self.accumulatedText)

                case .assistantThinkingDelta(let delta) where self.daemonSessionId != nil:
                    // Stay in thinking state while receiving thinking deltas
                    log.debug("Thinking: \(delta.thinking)")

                case .messageComplete(_) where self.daemonSessionId != nil:
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

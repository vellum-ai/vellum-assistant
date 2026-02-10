import Foundation

struct TurnLog: Codable {
    let step: Int
    let timestamp: Date
    let axTree: String?
    let hadScreenshot: Bool
    let usedVision: Bool
    let action: AgentAction
    let requestBytes: Int?
    let inputTokens: Int?
    let outputTokens: Int?
}

struct SessionAttachmentLog: Codable {
    let fileName: String
    let mimeType: String
    let sizeBytes: Int
    let kind: String
}

struct SessionLog: Codable {
    let task: String
    let startTime: Date
    let endTime: Date
    let result: String
    let attachments: [SessionAttachmentLog]
    let turns: [TurnLog]
}

final class SessionLogger {
    let task: String
    let startTime: Date
    private let attachments: [SessionAttachmentLog]
    private var turns: [TurnLog] = []

    init(task: String, attachments: [TaskAttachment] = []) {
        self.task = task
        self.startTime = Date()
        self.attachments = attachments.map {
            SessionAttachmentLog(
                fileName: $0.fileName,
                mimeType: $0.mimeType,
                sizeBytes: $0.sizeBytes,
                kind: $0.kind.rawValue
            )
        }
    }

    func logTurn(step: Int, axTree: String?, screenshot: Data?, action: AgentAction, usedVision: Bool, usage: TokenUsage? = nil) {
        let turn = TurnLog(
            step: step,
            timestamp: Date(),
            axTree: axTree,
            hadScreenshot: screenshot != nil,
            usedVision: usedVision,
            action: action,
            requestBytes: nil,
            inputTokens: usage?.inputTokens,
            outputTokens: usage?.outputTokens
        )
        turns.append(turn)
    }

    func finishSession(result: String) {
        let log = SessionLog(
            task: task,
            startTime: startTime,
            endTime: Date(),
            result: result,
            attachments: attachments,
            turns: turns
        )

        let fileManager = FileManager.default
        guard let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return }
        let logDir = appSupport.appendingPathComponent("vellum-assistant/logs", isDirectory: true)

        do {
            try fileManager.createDirectory(at: logDir, withIntermediateDirectories: true)

            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime]
            let timestamp = formatter.string(from: startTime)
                .replacingOccurrences(of: ":", with: "-")
            let fileName = "session-\(timestamp).json"
            let fileURL = logDir.appendingPathComponent(fileName)

            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = .prettyPrinted
            let data = try encoder.encode(log)
            try data.write(to: fileURL)
        } catch {
            print("Failed to save session log: \(error)")
        }
    }
}

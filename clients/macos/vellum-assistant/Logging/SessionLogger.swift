import Foundation

struct TurnLog: Codable {
    let step: Int
    let timestamp: Date
    let axTree: String?
    let hadScreenshot: Bool
    let usedVision: Bool
    let action: AgentAction
}

struct SessionLog: Codable {
    let task: String
    let startTime: Date
    let endTime: Date
    let result: String
    let turns: [TurnLog]
}

final class SessionLogger {
    let task: String
    let startTime: Date
    private var turns: [TurnLog] = []

    init(task: String) {
        self.task = task
        self.startTime = Date()
    }

    func logTurn(step: Int, axTree: String?, screenshot: Data?, action: AgentAction, usedVision: Bool) {
        let turn = TurnLog(
            step: step,
            timestamp: Date(),
            axTree: axTree,
            hadScreenshot: screenshot != nil,
            usedVision: usedVision,
            action: action
        )
        turns.append(turn)
    }

    func finishSession(result: String) {
        let log = SessionLog(
            task: task,
            startTime: startTime,
            endTime: Date(),
            result: result,
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

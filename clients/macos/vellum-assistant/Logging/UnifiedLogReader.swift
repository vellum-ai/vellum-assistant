import Foundation
import OSLog
import VellumAssistantShared

enum UnifiedLogSeverity: String, Sendable {
    case debug = "DEBUG"
    case info = "INFO"
    case notice = "NOTICE"
    case error = "ERROR"
    case fault = "FAULT"
    case other = "OTHER"

    init(level: OSLogEntryLog.Level) {
        switch level {
        case .debug:
            self = .debug
        case .info:
            self = .info
        case .notice:
            self = .notice
        case .error:
            self = .error
        case .fault:
            self = .fault
        default:
            self = .other
        }
    }
}

struct UnifiedLogEntry: Identifiable, Hashable, Sendable {
    let date: Date
    let level: UnifiedLogSeverity
    let category: String
    let message: String

    var id: String {
        "\(date.timeIntervalSince1970)|\(level.rawValue)|\(category)|\(message)"
    }

    var formattedLine: String {
        "[\(date.iso8601WithFractionalSecondsString)] [\(level.rawValue)] [\(category)] \(message)"
    }
}

enum UnifiedLogReader {
    static let defaultLookback: TimeInterval = 86_400
    static let defaultMaximumEntryCount: Int = 400

    static func readRecentEntries(
        since startDate: Date = Date().addingTimeInterval(-defaultLookback),
        maximumEntryCount: Int = defaultMaximumEntryCount,
        subsystem: String = Bundle.appBundleIdentifier
    ) throws -> [UnifiedLogEntry] {
        guard maximumEntryCount > 0 else { return [] }

        let store = try OSLogStore(scope: .currentProcessIdentifier)
        let position = store.position(date: startDate)
        let entries = try store.getEntries(
            at: position,
            matching: NSPredicate(format: "subsystem == %@", subsystem)
        )

        var buffer: [UnifiedLogEntry] = []
        buffer.reserveCapacity(min(maximumEntryCount, 256))

        for case let entry as OSLogEntryLog in entries {
            buffer.append(
                UnifiedLogEntry(
                    date: entry.date,
                    level: UnifiedLogSeverity(level: entry.level),
                    category: entry.category,
                    message: entry.composedMessage
                )
            )

            if buffer.count > maximumEntryCount {
                buffer.removeFirst(buffer.count - maximumEntryCount)
            }
        }

        return buffer
    }

    static func readFormattedRecentLines(
        since startDate: Date = Date().addingTimeInterval(-defaultLookback),
        maximumEntryCount: Int = defaultMaximumEntryCount,
        subsystem: String = Bundle.appBundleIdentifier
    ) throws -> [String] {
        try readRecentEntries(
            since: startDate,
            maximumEntryCount: maximumEntryCount,
            subsystem: subsystem
        ).map(\.formattedLine)
    }
}

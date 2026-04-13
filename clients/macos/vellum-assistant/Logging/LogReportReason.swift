import Foundation
import VellumAssistantShared

/// Pre-defined categories a user can pick when sharing feedback.
enum LogReportReason: String, CaseIterable, Identifiable, Sendable {
    case bugReport
    case featureRequest
    case other

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .bugReport: return "Bug Report"
        case .featureRequest: return "Feature Request"
        case .other: return "Other"
        }
    }

    /// Lucide icon raw value suitable for `VIcon.resolve(_:)`.
    var icon: String {
        switch self {
        case .bugReport: return VIcon.bug.rawValue
        case .featureRequest: return VIcon.lightbulb.rawValue
        case .other: return VIcon.messageCircle.rawValue
        }
    }

    /// Whether this category represents an error/issue that benefits from diagnostic logs.
    var isErrorCategory: Bool {
        switch self {
        case .bugReport:
            return true
        case .featureRequest, .other:
            return false
        }
    }
}

/// Determines what data the log export should include.
enum LogExportScope: Sendable {
    /// Full global export — all conversations, all data.
    case global
    /// Scoped to a single conversation.
    case conversation(conversationId: String, conversationTitle: String,
                      startTime: Date? = nil, endTime: Date? = nil)
}

/// Time window for diagnostic log collection.
enum LogTimeRange: String, CaseIterable, Identifiable, Sendable {
    case pastHour
    case past24Hours
    case allTime

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .pastHour: return "Past hour"
        case .past24Hours: return "Past 24 hours"
        case .allTime: return "All time"
        }
    }

    /// Returns the earliest `Date` that should be included, or `nil` for `.allTime`.
    var cutoffDate: Date? {
        switch self {
        case .pastHour: return Date().addingTimeInterval(-3600)
        case .past24Hours: return Date().addingTimeInterval(-86400)
        case .allTime: return nil
        }
    }
}

/// Aggregated form data collected from the feedback sheet.
struct LogReportFormData: Sendable {
    var reason: LogReportReason
    var name: String
    var message: String
    var email: String  // Required — used for follow-up via Sentry Feedback
    var scope: LogExportScope = .global
    var includeLogs: Bool = true
    var logTimeRange: LogTimeRange = .pastHour
    var attachments: [URL] = []
}

import Foundation
import VellumAssistantShared

/// Pre-defined categories a user can pick when sending a log report.
enum LogReportReason: String, CaseIterable, Identifiable, Sendable {
    case somethingBroken
    case appCrash
    case performanceIssue
    case connectionIssue
    case featureRequest
    case other

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .somethingBroken: return "Something isn't working"
        case .appCrash: return "App crashed or won't start"
        case .performanceIssue: return "Performance is slow"
        case .connectionIssue: return "Connection issue"
        case .featureRequest: return "Feature request"
        case .other: return "Other feedback"
        }
    }

    /// Lucide icon raw value suitable for `VIcon.resolve(_:)`.
    var icon: String {
        switch self {
        case .somethingBroken: return VIcon.bug.rawValue
        case .appCrash: return VIcon.triangleAlert.rawValue
        case .performanceIssue: return VIcon.zap.rawValue
        case .connectionIssue: return VIcon.wifiOff.rawValue
        case .featureRequest: return VIcon.lightbulb.rawValue
        case .other: return VIcon.messageCircle.rawValue
        }
    }

    /// Whether this category represents an error/issue that benefits from diagnostic logs.
    var isErrorCategory: Bool {
        switch self {
        case .somethingBroken, .appCrash, .performanceIssue, .connectionIssue:
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

/// Aggregated form data collected from the log report sheet.
struct LogReportFormData: Sendable {
    var reason: LogReportReason
    var name: String
    var message: String
    var email: String  // Required — used for follow-up via Sentry Feedback
    var scope: LogExportScope = .global
}

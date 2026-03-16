import Foundation
import VellumAssistantShared

/// Pre-defined categories a user can pick when sending a log report.
enum LogReportReason: String, CaseIterable, Identifiable, Sendable {
    case bugReport
    case performanceIssue
    case connectionIssue
    case assistantBehavior
    case appCrash
    case other

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .bugReport: return "Bug Report"
        case .performanceIssue: return "Performance Issue"
        case .connectionIssue: return "Connection Issue"
        case .assistantBehavior: return "Assistant Behavior"
        case .appCrash: return "App Crash"
        case .other: return "Other"
        }
    }

    /// Lucide icon raw value suitable for `VIcon.resolve(_:)`.
    var icon: String {
        switch self {
        case .bugReport: return VIcon.bug.rawValue
        case .performanceIssue: return VIcon.zap.rawValue
        case .connectionIssue: return VIcon.wifiOff.rawValue
        case .assistantBehavior: return VIcon.brain.rawValue
        case .appCrash: return VIcon.triangleAlert.rawValue
        case .other: return VIcon.messageCircle.rawValue
        }
    }
}

/// Determines what data the log export should include.
enum LogExportScope: Sendable {
    /// Full global export — all conversations, all data.
    case global
    /// Scoped to a single thread/conversation.
    case thread(conversationId: String, threadTitle: String,
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

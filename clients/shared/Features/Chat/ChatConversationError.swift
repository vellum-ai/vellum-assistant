import Foundation

/// Categorizes session errors for UI display and recovery suggestions.
public enum SessionErrorCategory: Equatable, Sendable {
    case providerNetwork
    case rateLimit
    case providerApi
    case providerBilling
    case providerOrdering
    case providerWebSearch
    case contextTooLarge
    case sessionAborted
    case processingFailed
    case regenerateFailed
    case authenticationRequired
    case unknown

    public init(from code: SessionErrorCode) {
        switch code {
        case .providerNetwork:
            self = .providerNetwork
        case .providerRateLimit:
            self = .rateLimit
        case .providerApi:
            self = .providerApi
        case .providerBilling:
            self = .providerBilling
        case .providerOrdering:
            self = .providerOrdering
        case .providerWebSearch:
            self = .providerWebSearch
        case .contextTooLarge:
            self = .contextTooLarge
        case .sessionAborted:
            self = .sessionAborted
        case .sessionProcessingFailed:
            self = .processingFailed
        case .regenerateFailed:
            self = .regenerateFailed
        case .authenticationRequired:
            self = .authenticationRequired
        case .unknown:
            self = .unknown
        }
    }

    /// User-facing recovery suggestion for this error category.
    public var recoverySuggestion: String {
        switch self {
        case .providerNetwork:
            return "Check your internet connection, then click Retry."
        case .rateLimit:
            return "Wait 30–60 seconds, then click Retry."
        case .providerApi:
            return "This is usually temporary — click Retry, or check your API key in Settings if it persists."
        case .providerBilling:
            return "Please add credits to your account or update your API key in Settings."
        case .providerOrdering:
            return "This is usually temporary — click Retry to continue."
        case .providerWebSearch:
            return "This is usually temporary — click Retry to continue."
        case .contextTooLarge:
            return "Start a new thread to reset context, or try a shorter message."
        case .sessionAborted:
            return "Send a new message to continue the conversation."
        case .processingFailed:
            return "Click Retry or send your message again. Copy debug info if the problem repeats."
        case .regenerateFailed:
            return "Click Retry to regenerate, or send a new message instead."
        case .authenticationRequired:
            return "Sign in or check your credentials in Settings to continue."
        case .unknown:
            return "Click Retry or send a new message. Copy debug info if the problem repeats."
        }
    }
}

/// Typed error state for session-level errors from the daemon.
public struct SessionError: Equatable {
    public let category: SessionErrorCategory
    public let message: String
    public let isRetryable: Bool
    public let recoverySuggestion: String
    public let sessionId: String
    public let debugDetails: String?
    /// Machine-readable error category for log report metadata and triage.
    public let errorCategory: String?

    public init(from msg: SessionErrorMessage) {
        self.category = SessionErrorCategory(from: msg.code)
        self.message = msg.userMessage
        self.isRetryable = msg.retryable
        self.recoverySuggestion = self.category.recoverySuggestion
        self.sessionId = msg.sessionId
        self.debugDetails = msg.debugDetails
        self.errorCategory = msg.errorCategory
    }

    public init(category: SessionErrorCategory, message: String, isRetryable: Bool, sessionId: String, debugDetails: String? = nil, errorCategory: String? = nil) {
        self.category = category
        self.message = message
        self.isRetryable = isRetryable
        self.recoverySuggestion = category.recoverySuggestion
        self.sessionId = sessionId
        self.debugDetails = debugDetails
        self.errorCategory = errorCategory
    }
}

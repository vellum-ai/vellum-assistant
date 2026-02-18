import Foundation

/// Categorizes session errors for UI display and recovery suggestions.
public enum SessionErrorCategory: Equatable, Sendable {
    case providerNetwork
    case rateLimit
    case providerApi
    case contextTooLarge
    case queueFull
    case sessionAborted
    case processingFailed
    case regenerateFailed
    case unknown

    public init(from code: SessionErrorCode) {
        switch code {
        case .providerNetwork:
            self = .providerNetwork
        case .providerRateLimit:
            self = .rateLimit
        case .providerApi:
            self = .providerApi
        case .contextTooLarge:
            self = .contextTooLarge
        case .queueFull:
            self = .queueFull
        case .sessionAborted:
            self = .sessionAborted
        case .sessionProcessingFailed:
            self = .processingFailed
        case .regenerateFailed:
            self = .regenerateFailed
        case .unknown:
            self = .unknown
        }
    }

    /// User-facing recovery suggestion for this error category.
    public var recoverySuggestion: String {
        switch self {
        case .providerNetwork:
            return "Check your internet connection and try again."
        case .rateLimit:
            return "You've hit a rate limit. Please wait a moment before retrying."
        case .providerApi:
            return "The AI provider returned an error. Try again or check your API key."
        case .contextTooLarge:
            return "Start a new conversation or try a shorter message."
        case .queueFull:
            return "Too many pending messages. Wait for current messages to finish processing."
        case .sessionAborted:
            return "The session was interrupted. Send a new message to continue."
        case .processingFailed:
            return "Message processing failed. Try sending your message again."
        case .regenerateFailed:
            return "Could not regenerate the response. Try again."
        case .unknown:
            return "An unexpected error occurred. Try again."
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

    public init(from msg: SessionErrorMessage) {
        self.category = SessionErrorCategory(from: msg.code)
        self.message = msg.userMessage
        self.isRetryable = msg.retryable
        self.recoverySuggestion = self.category.recoverySuggestion
        self.sessionId = msg.sessionId
        self.debugDetails = msg.debugDetails
    }

    public init(category: SessionErrorCategory, message: String, isRetryable: Bool, sessionId: String, debugDetails: String? = nil) {
        self.category = category
        self.message = message
        self.isRetryable = isRetryable
        self.recoverySuggestion = category.recoverySuggestion
        self.sessionId = sessionId
        self.debugDetails = debugDetails
    }
}

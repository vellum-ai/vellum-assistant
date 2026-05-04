import Foundation

/// Categorizes conversation errors for UI display and recovery suggestions.
public enum ConversationErrorCategory: Equatable, Sendable {
    case providerNetwork
    case rateLimit
    case managedUsageLimit
    case providerOverloaded
    case providerApi
    case providerBilling
    case providerOrdering
    case providerWebSearch
    case contextTooLarge
    case conversationAborted
    case processingFailed
    case regenerateFailed
    case authenticationRequired
    case providerNotConfigured
    case managedKeyInvalid
    case unknown

    public init(from code: ConversationErrorCode) {
        switch code {
        case .providerNetwork:
            self = .providerNetwork
        case .providerRateLimit:
            self = .rateLimit
        case .managedUsageLimit:
            self = .managedUsageLimit
        case .providerOverloaded:
            self = .providerOverloaded
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
        case .conversationAborted:
            self = .conversationAborted
        case .conversationProcessingFailed:
            self = .processingFailed
        case .regenerateFailed:
            self = .regenerateFailed
        case .authenticationRequired:
            self = .authenticationRequired
        case .providerNotConfigured:
            self = .providerNotConfigured
        case .managedKeyInvalid:
            self = .managedKeyInvalid
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
        case .managedUsageLimit:
            return "This is a Vellum-managed usage limit. Wait for it to reset or switch to your API key in Settings."
        case .providerOverloaded:
            return "This is usually temporary — click Retry in a moment."
        case .providerApi:
            return "This is usually temporary — click Retry, or check your API key in Settings if it persists."
        case .providerBilling:
            return "Please add credits to your account or update your API key in Settings."
        case .providerOrdering:
            return "This is usually temporary — click Retry to continue."
        case .providerWebSearch:
            return "This is usually temporary — click Retry to continue."
        case .contextTooLarge:
            return "Start a new conversation to reset context, or try a shorter message."
        case .conversationAborted:
            return "Send a new message to continue the conversation."
        case .processingFailed:
            return "Click Retry or send your message again. Copy debug info if the problem repeats."
        case .regenerateFailed:
            return "Click Retry to regenerate, or send a new message instead."
        case .authenticationRequired:
            return "Sign in or check your credentials in Settings to continue."
        case .providerNotConfigured:
            return "Add your API key in Settings to continue."
        case .managedKeyInvalid:
            return "The assistant API key is being refreshed. Please retry in a moment."
        case .unknown:
            return "Click Retry or send a new message. Copy debug info if the problem repeats."
        }
    }
}

/// Typed error state for conversation-level errors from the daemon.
public struct ConversationError: Equatable {
    public let category: ConversationErrorCategory
    public let message: String
    public let isRetryable: Bool
    public let recoverySuggestion: String
    public let conversationId: String
    public let debugDetails: String?
    /// Machine-readable error category for log report metadata and triage.
    public let errorCategory: String?

    public init(from msg: ConversationErrorMessage) {
        self.category = ConversationErrorCategory(from: msg.code)
        self.message = msg.userMessage
        self.isRetryable = msg.retryable
        self.recoverySuggestion = self.category.recoverySuggestion
        self.conversationId = msg.conversationId
        self.debugDetails = msg.debugDetails
        self.errorCategory = msg.errorCategory
    }

    public init(category: ConversationErrorCategory, message: String, isRetryable: Bool, conversationId: String, debugDetails: String? = nil, errorCategory: String? = nil) {
        self.category = category
        self.message = message
        self.isRetryable = isRetryable
        self.recoverySuggestion = category.recoverySuggestion
        self.conversationId = conversationId
        self.debugDetails = debugDetails
        self.errorCategory = errorCategory
    }

    /// Whether this error indicates that the user's credits are exhausted.
    /// Matches both plain "credits_exhausted" and prefixed variants like "regenerate:credits_exhausted".
    public var isCreditsExhausted: Bool {
        errorCategory?.hasSuffix("credits_exhausted") == true
    }

    /// Whether this error indicates that no provider is configured for inference.
    public var isProviderNotConfigured: Bool {
        category == .providerNotConfigured
    }

    /// Whether this error indicates the managed assistant API key is invalid and should be reprovisioned.
    public var isManagedKeyInvalid: Bool {
        category == .managedKeyInvalid
    }
}

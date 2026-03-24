import SwiftUI

/// A polished inline alert card rendered in the chat message list for conversation errors.
///
/// Replaces the raw error text with a structured alert that shows:
/// - Category-specific icon and title
/// - Error message body
/// - Recovery suggestion
///
/// When `conversationError` metadata is available, the alert renders with full
/// category-aware styling. Falls back to a generic alert for plain `isError` messages.
public struct InlineChatErrorAlert: View {
    let message: String
    let conversationError: ConversationError?
    let onRetry: (() -> Void)?

    public init(message: String, conversationError: ConversationError? = nil, onRetry: (() -> Void)? = nil) {
        self.message = message
        self.conversationError = conversationError
        self.onRetry = onRetry
    }

    private var category: ConversationErrorCategory {
        conversationError?.category ?? .unknown
    }

    private var accentColor: Color {
        switch category {
        case .rateLimit, .providerNetwork, .contextTooLarge, .providerOrdering, .providerWebSearch:
            return VColor.systemMidStrong
        case .conversationAborted:
            return VColor.systemPositiveStrong
        default:
            return VColor.systemNegativeStrong
        }
    }

    private var icon: VIcon {
        switch category {
        case .providerNetwork: return .wifiOff
        case .rateLimit: return .clockAlert
        case .providerApi, .providerOrdering, .providerWebSearch: return .cloudOff
        case .providerBilling: return .creditCard
        case .contextTooLarge: return .fileText
        case .conversationAborted: return .circleStop
        case .processingFailed, .regenerateFailed: return .refreshCw
        case .authenticationRequired: return .lock
        case .providerNotConfigured: return .keyRound
        case .unknown: return .circleAlert
        }
    }

    private var categoryTitle: String {
        switch category {
        case .providerNetwork: return "Network Error"
        case .rateLimit: return "Rate Limited"
        case .providerApi: return "API Error"
        case .providerBilling: return "Billing Error"
        case .providerOrdering: return "Processing Error"
        case .providerWebSearch: return "Web Search Error"
        case .contextTooLarge: return "Context Too Large"
        case .conversationAborted: return "Conversation Stopped"
        case .processingFailed: return "Processing Failed"
        case .regenerateFailed: return "Regeneration Failed"
        case .authenticationRequired: return "Authentication Required"
        case .providerNotConfigured: return "API Key Required"
        case .unknown: return "Error"
        }
    }

    private var recoverySuggestion: String? {
        conversationError?.recoverySuggestion
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 0) {
            // Left accent bar — provides category color at a glance
            RoundedRectangle(cornerRadius: 2)
                .fill(accentColor)
                .frame(width: 3)
                .padding(.vertical, 1)

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                // Header: icon + category title
                HStack(spacing: VSpacing.xs) {
                    VIconView(icon, size: 13)
                        .foregroundStyle(accentColor)
                    Text(categoryTitle)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentEmphasized)
                }

                // Error message body
                Text(message)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)

                // Recovery suggestion
                if let suggestion = recoverySuggestion {
                    Text(suggestion)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                // Retry button
                if conversationError?.isRetryable == true, let onRetry {
                    Button(action: onRetry) {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.rotateCcw, size: 11)
                            Text("Retry")
                        }
                        .font(VFont.labelDefault)
                        .foregroundStyle(accentColor)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(accentColor.opacity(0.1))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Retry")
                }
            }
            .padding(.leading, VSpacing.md)
            .padding(.trailing, VSpacing.lg)
            .padding(.vertical, VSpacing.md)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(accentColor.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .strokeBorder(accentColor.opacity(0.15), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }
}

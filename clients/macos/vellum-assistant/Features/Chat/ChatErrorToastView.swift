import SwiftUI
import VellumAssistantShared

// MARK: - Conversation Error Toast

/// Unified error toast displayed above the composer with solid accent background and white text.
///
/// Supports two initialization paths:
/// 1. From a typed `ConversationError` (category-based icon, color, and recovery suggestion)
/// 2. From an unstructured message string (icon, color, and action are customizable)
struct ChatConversationErrorToast: View {
    // MARK: - Display Properties

    private let icon: VIcon
    private let message: String
    private let subtitle: String?
    private let accent: Color
    private let actionLabel: String?
    private let onAction: (() -> Void)?
    private let showCopyDebug: Bool
    private let onCopyDebugInfo: (() -> Void)?
    private let onDismiss: (() -> Void)?

    // MARK: - ConversationError Init

    /// Initialize from a typed `ConversationError` with category-based styling.
    init(
        error: ConversationError,
        onRetry: @escaping () -> Void,
        onCopyDebugInfo: @escaping () -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.icon = Self.iconForCategory(error.category)
        self.message = error.message
        self.subtitle = error.recoverySuggestion
        self.accent = Self.accentColor(for: error.category)
        self.actionLabel = error.isRetryable ? Self.actionLabel(for: error.category) : nil
        self.onAction = error.isRetryable ? onRetry : nil
        self.showCopyDebug = true
        self.onCopyDebugInfo = onCopyDebugInfo
        self.onDismiss = onDismiss
    }

    // MARK: - Unstructured Message Init

    /// Initialize from an unstructured error message with customizable styling.
    init(
        message: String,
        subtitle: String? = nil,
        icon: VIcon = .circleAlert,
        accentColor: Color = VColor.systemNegativeStrong,
        actionLabel: String? = nil,
        onAction: (() -> Void)? = nil,
        onDismiss: (() -> Void)? = nil
    ) {
        self.icon = icon
        self.message = message
        self.subtitle = subtitle
        self.accent = accentColor
        self.actionLabel = actionLabel
        self.onAction = onAction
        self.showCopyDebug = false
        self.onCopyDebugInfo = nil
        self.onDismiss = onDismiss
    }

    // MARK: - Body

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(icon, size: 14)

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(message)
                    .font(VFont.bodyMediumLighter)
                    .lineLimit(nil)
                    .textSelection(.enabled)

                if let subtitle {
                    Text(subtitle)
                        .font(VFont.labelSmall)
                        .opacity(0.8)
                        .lineLimit(2)
                        .textSelection(.enabled)
                }
            }

            if actionLabel != nil || showCopyDebug || onDismiss != nil {
                Spacer(minLength: VSpacing.xl)
            }

            if let actionLabel, let onAction {
                Button(action: onAction) {
                    Text(actionLabel)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.auxWhite) // color-literal-ok
                        .padding(.horizontal, VSpacing.sm)
                        .frame(height: 24)
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .strokeBorder(VColor.auxWhite, lineWidth: 1.5)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(actionLabel)
            }

            if showCopyDebug, let onCopyDebugInfo {
                Button(action: onCopyDebugInfo) {
                    VIconView(.clipboard, size: 11)
                        .opacity(0.8)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy debug info")
            }

            if let onDismiss {
                Button {
                    onDismiss()
                } label: {
                    VIconView(.x, size: 14)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss error")
            }
        }
        .foregroundStyle(VColor.auxWhite) // Intentional: always white on solid accent background
        .frame(minHeight: 32)
        .padding(.leading, VSpacing.md)
        .padding(.trailing, VSpacing.lg)
        .padding(.vertical, VSpacing.xs)
        .background(accent)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    // MARK: - Category Helpers

    /// VIcon appropriate for each error category.
    private static func iconForCategory(_ category: ConversationErrorCategory) -> VIcon {
        switch category {
        case .providerNetwork:
            return .wifiOff
        case .rateLimit:
            return .clockAlert
        case .providerApi:
            return .cloudOff
        case .providerBilling:
            return .creditCard
        case .providerOrdering:
            return .cloudOff
        case .providerWebSearch:
            return .cloudOff
        case .contextTooLarge:
            return .fileText
        case .conversationAborted:
            return .circleStop
        case .processingFailed, .regenerateFailed:
            return .refreshCw
        case .authenticationRequired:
            return .lock
        case .providerNotConfigured:
            return .keyRound
        case .unknown:
            return .circleAlert
        }
    }

    /// Accent color for each error category — warm for transient/retryable,
    /// red for hard failures.
    private static func accentColor(for category: ConversationErrorCategory) -> Color {
        switch category {
        case .rateLimit:
            return VColor.systemMidStrong
        case .providerNetwork:
            return VColor.systemMidStrong
        case .conversationAborted:
            return VColor.systemPositiveStrong
        case .contextTooLarge:
            return VColor.systemMidStrong
        case .providerOrdering, .providerWebSearch:
            return VColor.systemMidStrong
        default:
            return VColor.systemNegativeStrong
        }
    }

    /// Action button label tailored to the error category.
    private static func actionLabel(for category: ConversationErrorCategory) -> String {
        switch category {
        case .rateLimit:
            return "Retry"
        case .regenerateFailed:
            return "Retry"
        case .providerNetwork:
            return "Retry"
        default:
            return "Retry"
        }
    }
}

// MARK: - Credits Exhausted Banner

/// Inline banner shown when the user's credits are exhausted.
/// Uses a warm, encouraging tone with a visual gauge and clear CTA.
struct CreditsExhaustedBanner: View {
    let onAddFunds: () -> Void

    var body: some View {
        HStack(spacing: VSpacing.xl) {
            VStack(alignment: .leading, spacing: 2) {
                Text("💰  Your balance has run out")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentEmphasized)
                Text("Add funds to pick up where you left off.")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            VButton(label: "Add Funds", style: .primary) {
                onAddFunds()
            }
        }
        .padding(VSpacing.lg)
        .background(VColor.surfaceActive)
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: VRadius.lg,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: VRadius.lg
            )
        )
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

// MARK: - Missing API Key Banner

/// Inline banner shown when the user attempts to chat without a configured API key.
/// Presents a dismiss button, title, subtitle, and a full-width CTA to open settings.
struct MissingApiKeyBanner: View {
    let onOpenSettings: () -> Void
    let onDismiss: (() -> Void)?

    var body: some View {
        VStack(spacing: VSpacing.md) {
            HStack {
                Spacer()
                Button { onDismiss?() } label: {
                    VIconView(.x, size: 12)
                        .foregroundStyle(VColor.contentSecondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }

            VStack(spacing: VSpacing.xs) {
                Text("API key required")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentEmphasized)
                Text("Add an API key in Settings to start chatting.")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }

            VButton(label: "Open Settings", style: .primary) {
                onOpenSettings()
            }
            .frame(maxWidth: .infinity)
        }
        .padding(VSpacing.lg)
        .background(VColor.surfaceActive)
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: VRadius.lg,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: VRadius.lg
            )
        )
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

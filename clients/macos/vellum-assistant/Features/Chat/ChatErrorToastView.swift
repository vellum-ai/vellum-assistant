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
                    .font(VFont.body)
                    .lineLimit(nil)
                    .textSelection(.enabled)

                if let subtitle {
                    Text(subtitle)
                        .font(VFont.small)
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
                        .font(VFont.caption)
                        .foregroundColor(VColor.auxWhite) // color-literal-ok
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
        .foregroundColor(VColor.auxWhite) // Intentional: always white on solid accent background
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
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            // Top section: gauge + message
            VStack(spacing: VSpacing.md) {
                // Header row with dismiss
                HStack {
                    Spacer()
                    Button {
                        onDismiss()
                    } label: {
                        VIconView(.x, size: 12)
                            .foregroundColor(VColor.contentTertiary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss")
                }

                // Empty gauge indicator
                creditsGauge

                // Message
                VStack(spacing: VSpacing.xs) {
                    Text("Your balance has run out")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.contentEmphasized)
                    Text("Add funds to pick up where you left off.")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                }
            }
            .padding(.top, VSpacing.sm)
            .padding(.horizontal, VSpacing.lg)
            .padding(.bottom, VSpacing.lg)

            // Divider
            Rectangle()
                .fill(VColor.borderBase)
                .frame(height: 1)

            // CTA section
            HStack {
                VButton(label: "Add Funds", style: .primary, isFullWidth: true) {
                    onAddFunds()
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)
        }
        .background(VColor.surfaceActive)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .strokeBorder(VColor.borderBase, lineWidth: 1)
        )
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    // MARK: - Credits Gauge

    /// Visual gauge showing an empty credits state — a horizontal bar
    /// that's fully depleted with a small amber indicator at the empty end.
    private var creditsGauge: some View {
        VStack(spacing: VSpacing.xs) {
            ZStack(alignment: .leading) {
                // Track
                Capsule()
                    .fill(VColor.contentTertiary.opacity(0.3))
                    .frame(height: 6)

                // Empty fill (small indicator showing "0")
                Capsule()
                    .fill(VColor.systemMidStrong)
                    .frame(width: 8, height: 6)
            }
            .frame(maxWidth: .infinity)

            // Label
            Text("$0.00 remaining")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

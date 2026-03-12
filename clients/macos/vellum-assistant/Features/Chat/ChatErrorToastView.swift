import SwiftUI
import VellumAssistantShared

// MARK: - Session Error Toast

/// Unified error toast displayed above the composer with solid accent background and white text.
///
/// Supports two initialization paths:
/// 1. From a typed `SessionError` (category-based icon, color, and recovery suggestion)
/// 2. From an unstructured message string (icon, color, and action are customizable)
struct ChatSessionErrorToast: View {
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

    // MARK: - SessionError Init

    /// Initialize from a typed `SessionError` with category-based styling.
    init(
        error: SessionError,
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
        icon: VIcon = .triangleAlert,
        accentColor: Color = VColor.error,
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
                .offset(y: -1)

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(message)
                    .font(VFont.caption)
                    .lineLimit(4)
                    .textSelection(.enabled)

                if let subtitle {
                    Text(subtitle)
                        .font(VFont.small)
                        .opacity(0.8)
                        .lineLimit(2)
                        .textSelection(.enabled)
                }
            }

            Spacer()

            if let actionLabel, let onAction {
                Button(action: onAction) {
                    Text(actionLabel)
                        .font(VFont.captionMedium)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(Color.white.opacity(0.2)) // Intentional: translucent contrast on solid accent background
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
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
        .foregroundColor(.white) // Intentional: always white on solid accent background
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
    private static func iconForCategory(_ category: SessionErrorCategory) -> VIcon {
        switch category {
        case .providerNetwork:
            return .wifiOff
        case .rateLimit:
            return .clockAlert
        case .providerApi:
            return .cloudOff
        case .providerBilling:
            return .creditCard
        case .contextTooLarge:
            return .fileText
        case .sessionAborted:
            return .circleStop
        case .processingFailed, .regenerateFailed:
            return .refreshCw
        case .authenticationRequired:
            return .lock
        case .unknown:
            return .triangleAlert
        }
    }

    /// Accent color for each error category — warm for transient/retryable,
    /// red for hard failures.
    private static func accentColor(for category: SessionErrorCategory) -> Color {
        switch category {
        case .rateLimit:
            return VColor.warning
        case .providerNetwork:
            return Amber._500
        case .sessionAborted:
            return VColor.textSecondary
        case .contextTooLarge:
            return VColor.warning
        default:
            return VColor.error
        }
    }

    /// Action button label tailored to the error category.
    private static func actionLabel(for category: SessionErrorCategory) -> String {
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

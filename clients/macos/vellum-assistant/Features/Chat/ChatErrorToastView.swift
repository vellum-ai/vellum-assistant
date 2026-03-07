import SwiftUI
import VellumAssistantShared

/// Generic error banner displayed above the composer (red background, white text).
struct ChatErrorBanner: View {
    let text: String
    let isSecretBlockError: Bool
    let onSendAnyway: () -> Void
    let isRetryableError: Bool
    let onRetryError: () -> Void
    let isConnectionError: Bool
    var hasRetryPayload: Bool = true
    var connectionDiagnosticHint: String? = nil
    let onDismissError: () -> Void

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.triangleAlert, size: 14)

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(text)
                    .font(VFont.caption)
                    .lineLimit(4)
                    .textSelection(.enabled)
                if isConnectionError, let hint = connectionDiagnosticHint {
                    Text(hint)
                        .font(VFont.small)
                        .opacity(0.8)
                        .lineLimit(2)
                        .textSelection(.enabled)
                }
            }

            Spacer()

            if isSecretBlockError {
                Button(action: onSendAnyway) {
                    Text("Send Anyway")
                        .font(VFont.captionMedium)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(Color.white.opacity(0.2)) // Intentional: translucent contrast on VColor.error banner
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Send message anyway")
            } else if isRetryableError || (isConnectionError && hasRetryPayload) {
                Button(action: onRetryError) {
                    Text("Retry")
                        .font(VFont.captionMedium)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(Color.white.opacity(0.2)) // Intentional: translucent contrast on VColor.error banner
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Retry sending message")
            }

            Button {
                onDismissError()
            } label: {
                VIconView(.x, size: 14)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss error")
        }
        .foregroundColor(.white) // Intentional: always white on VColor.error background
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.error)
    }
}

// MARK: - Session Error Toast

/// Structured error toast for session-level errors with category-based styling.
struct ChatSessionErrorToast: View {
    let error: SessionError
    let onRetry: () -> Void
    let onCopyDebugInfo: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(iconForCategory(error.category), size: 14)
                .foregroundColor(accentColor(for: error.category))

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(error.message)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(2)
                    .textSelection(.enabled)

                Text(error.recoverySuggestion)
                    .font(VFont.small)
                    .foregroundColor(VColor.textSecondary)
                    .lineLimit(1)
                    .textSelection(.enabled)
            }

            Spacer()

            if error.isRetryable {
                Button(action: onRetry) {
                    Text(actionLabel(for: error.category))
                        .font(VFont.captionMedium)
                        .foregroundColor(.white) // Intentional: always white on accent background
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(accentColor(for: error.category))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(actionLabel(for: error.category))
            }

            if error.debugDetails != nil {
                Button(action: onCopyDebugInfo) {
                    VIconView(.clipboard, size: 11)
                        .foregroundColor(VColor.textSecondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy debug info")
            }

            Button {
                onDismiss()
            } label: {
                VIconView(.x, size: 10)
                    .foregroundColor(VColor.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss error")
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(accentColor(for: error.category).opacity(0.1))
        .overlay(
            Rectangle()
                .fill(accentColor(for: error.category))
                .frame(width: 3),
            alignment: .leading
        )
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    // MARK: - Category Helpers

    /// VIcon appropriate for each error category.
    private func iconForCategory(_ category: SessionErrorCategory) -> VIcon {
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
        case .queueFull:
            return .inbox
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
    private func accentColor(for category: SessionErrorCategory) -> Color {
        switch category {
        case .rateLimit, .queueFull:
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
    private func actionLabel(for category: SessionErrorCategory) -> String {
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

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
            Image(systemName: "exclamationmark.triangle.fill")
                .font(VFont.caption)

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
                Image(systemName: "xmark")
                    .font(VFont.caption)
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
            Image(systemName: iconName(for: error.category))
                .font(.system(size: 14, weight: .semibold))
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
                    Image(systemName: "doc.on.clipboard")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(VColor.textSecondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy debug info")
            }

            Button {
                onDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .medium))
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

    /// SF Symbol icon appropriate for each error category.
    private func iconName(for category: SessionErrorCategory) -> String {
        switch category {
        case .providerNetwork:
            return "wifi.exclamationmark"
        case .rateLimit:
            return "clock.badge.exclamationmark"
        case .providerApi:
            return "exclamationmark.icloud.fill"
        case .providerBilling:
            return "creditcard.trianglebadge.exclamationmark"
        case .contextTooLarge:
            return "text.badge.xmark"
        case .queueFull:
            return "tray.full.fill"
        case .sessionAborted:
            return "stop.circle.fill"
        case .processingFailed, .regenerateFailed:
            return "arrow.triangle.2.circlepath"
        case .authenticationRequired:
            return "lock.fill"
        case .unknown:
            return "exclamationmark.triangle.fill"
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

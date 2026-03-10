#if DEBUG
import SwiftUI
import VellumAssistantShared

// MARK: - Error Banner Gallery

/// Visual catalog of all error banner and toast components for side-by-side comparison.
struct ErrorBannerGalleryView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.xxl) {

                // MARK: - Shared ChatErrorBanner

                sectionHeader(
                    "Shared ChatErrorBanner",
                    description: "Simple warning banner with dismiss (from VellumAssistantShared)."
                )

                VellumAssistantShared.ChatErrorBanner(
                    message: "Something went wrong. Please try again.",
                    onDismiss: {}
                )

                divider()

                // MARK: - macOS ChatErrorBanner

                sectionHeader(
                    "macOS ChatErrorBanner",
                    description: "Red error banner displayed above the composer with action variants."
                )

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    label("Basic with dismiss")
                    ChatErrorBanner(
                        text: "An unexpected error occurred.",
                        isSecretBlockError: false,
                        onSendAnyway: {},
                        isRetryableError: false,
                        onRetryError: {},
                        isConnectionError: false,
                        onDismissError: {}
                    )
                }

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    label("Secret block error — Send Anyway")
                    ChatErrorBanner(
                        text: "Your message may contain sensitive information.",
                        isSecretBlockError: true,
                        onSendAnyway: {},
                        isRetryableError: false,
                        onRetryError: {},
                        isConnectionError: false,
                        onDismissError: {}
                    )
                }

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    label("Retryable error — Retry")
                    ChatErrorBanner(
                        text: "The request failed. Please retry.",
                        isSecretBlockError: false,
                        onSendAnyway: {},
                        isRetryableError: true,
                        onRetryError: {},
                        isConnectionError: false,
                        onDismissError: {}
                    )
                }

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    label("Connection error with diagnostic hint")
                    ChatErrorBanner(
                        text: "Unable to reach the server.",
                        isSecretBlockError: false,
                        onSendAnyway: {},
                        isRetryableError: false,
                        onRetryError: {},
                        isConnectionError: true,
                        hasRetryPayload: true,
                        connectionDiagnosticHint: "Check that the daemon is running on port 8080.",
                        onDismissError: {}
                    )
                }

                divider()

                // MARK: - ChatSessionErrorToast

                sectionHeader(
                    "ChatSessionErrorToast",
                    description: "Structured error toast with category-based icon, color, and recovery suggestion."
                )

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    label("providerNetwork")
                    ChatSessionErrorToast(
                        error: SessionError(
                            category: .providerNetwork,
                            message: "Network connection lost.",
                            isRetryable: true,
                            sessionId: "preview-1"
                        ),
                        onRetry: {},
                        onCopyDebugInfo: {},
                        onDismiss: {}
                    )
                }

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    label("rateLimit")
                    ChatSessionErrorToast(
                        error: SessionError(
                            category: .rateLimit,
                            message: "Rate limit exceeded. Please wait before retrying.",
                            isRetryable: true,
                            sessionId: "preview-2"
                        ),
                        onRetry: {},
                        onCopyDebugInfo: {},
                        onDismiss: {}
                    )
                }

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    label("providerBilling")
                    ChatSessionErrorToast(
                        error: SessionError(
                            category: .providerBilling,
                            message: "Insufficient credits on your API account.",
                            isRetryable: false,
                            sessionId: "preview-3",
                            debugDetails: "billing_error: insufficient_funds"
                        ),
                        onRetry: {},
                        onCopyDebugInfo: {},
                        onDismiss: {}
                    )
                }

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    label("unknown")
                    ChatSessionErrorToast(
                        error: SessionError(
                            category: .unknown,
                            message: "An unknown error occurred.",
                            isRetryable: true,
                            sessionId: "preview-4",
                            debugDetails: "error_id: abc-123"
                        ),
                        onRetry: {},
                        onCopyDebugInfo: {},
                        onDismiss: {}
                    )
                }

                divider()

                // MARK: - APIKeyBanner

                sectionHeader(
                    "APIKeyBanner",
                    description: "Warning banner prompting the user to set an API key."
                )

                APIKeyBanner(onOpenSettings: {})

                divider()

                // MARK: - VToast Styles

                sectionHeader(
                    "VToast",
                    description: "Design system toast with info, success, warning, and error styles."
                )

                VStack(spacing: VSpacing.md) {
                    VToast(message: "Here's some useful information.", style: .info)
                    VToast(message: "Operation completed successfully!", style: .success)
                    VToast(message: "Please check your configuration.", style: .warning)
                    VToast(message: "Something went wrong.", style: .error)
                    VToast(
                        message: "Error with all actions",
                        style: .error,
                        primaryAction: VToastAction(label: "Retry") {},
                        secondaryAction: VToastAction(label: "Copy Debug Info") {},
                        onDismiss: {}
                    )
                }
            }
            .padding(VSpacing.xl)
        }
    }

    // MARK: - Helpers

    private func sectionHeader(_ title: String, description: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(title)
                .font(VFont.headline)
                .foregroundColor(VColor.textPrimary)
            Text(description)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
        }
    }

    private func label(_ text: String) -> some View {
        Text(text)
            .font(VFont.caption)
            .foregroundColor(VColor.textMuted)
            .padding(.leading, VSpacing.sm)
    }

    private func divider() -> some View {
        Divider()
            .background(VColor.surfaceBorder)
            .padding(.vertical, VSpacing.md)
    }
}

// MARK: - Previews

#Preview("Error Banner Gallery") {
    ZStack {
        VColor.background.ignoresSafeArea()
        ErrorBannerGalleryView()
    }
    .frame(width: 600, height: 900)
}
#endif

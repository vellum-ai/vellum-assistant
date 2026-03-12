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

                // MARK: - ChatSessionErrorToast (Message Init)

                sectionHeader(
                    "ChatSessionErrorToast — Message Init",
                    description: "Solid accent background toast for unstructured error messages."
                )

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    label("Basic with dismiss")
                    ChatSessionErrorToast(
                        message: "An unexpected error occurred.",
                        onDismiss: {}
                    )
                }

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    label("Secret block error — Send Anyway")
                    ChatSessionErrorToast(
                        message: "Your message may contain sensitive information.",
                        actionLabel: "Send Anyway",
                        onAction: {},
                        onDismiss: {}
                    )
                }

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    label("Retryable error — Retry")
                    ChatSessionErrorToast(
                        message: "The request failed. Please retry.",
                        actionLabel: "Retry",
                        onAction: {},
                        onDismiss: {}
                    )
                }

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    label("Connection error with diagnostic hint")
                    ChatSessionErrorToast(
                        message: "Unable to reach the server.",
                        subtitle: "Check that the assistant is running on port 8080.",
                        actionLabel: "Retry",
                        onAction: {},
                        onDismiss: {}
                    )
                }

                divider()

                // MARK: - ChatSessionErrorToast (SessionError Init)

                sectionHeader(
                    "ChatSessionErrorToast — SessionError Init",
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
                    label("unknown with debug details")
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

                // MARK: - API Key Warning (via ChatSessionErrorToast)

                sectionHeader(
                    "API Key Warning",
                    description: "Missing API key warning using ChatSessionErrorToast with warning style."
                )

                ChatSessionErrorToast(
                    message: "API key not set. Add one in Settings to start chatting.",
                    icon: .keyRound,
                    accentColor: VColor.systemNegativeHover,
                    actionLabel: "Open Settings",
                    onAction: {},
                    onDismiss: {}
                )

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
                .foregroundColor(VColor.contentDefault)
            Text(description)
                .font(VFont.caption)
                .foregroundColor(VColor.contentSecondary)
        }
    }

    private func label(_ text: String) -> some View {
        Text(text)
            .font(VFont.caption)
            .foregroundColor(VColor.contentTertiary)
            .padding(.leading, VSpacing.sm)
    }

    private func divider() -> some View {
        Divider()
            .background(VColor.borderBase)
            .padding(.vertical, VSpacing.md)
    }
}

// MARK: - Previews

#Preview("Error Banner Gallery") {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        ErrorBannerGalleryView()
    }
    .frame(width: 600, height: 900)
}
#endif

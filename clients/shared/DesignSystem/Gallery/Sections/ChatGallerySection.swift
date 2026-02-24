#if DEBUG
import SwiftUI

struct ChatGallerySection: View {
    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            // MARK: - Error Banners
            GallerySectionHeader(
                title: "Error Banners",
                description: "ChatErrorBanner — dismissible banner for non-retryable session errors."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    Text("Without dismiss")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    ChatErrorBanner(message: "Connection lost.")

                    Divider().background(VColor.surfaceBorder)

                    Text("Medium message")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    ChatErrorBanner(message: "The AI provider returned an error. Please try again later.")

                    Divider().background(VColor.surfaceBorder)

                    Text("With dismiss action")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    ChatErrorBanner(
                        message: "Your session has expired. Please start a new conversation.",
                        onDismiss: {}
                    )
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - Skill Invocation
            GallerySectionHeader(
                title: "Skill Invocation",
                description: "SkillInvocationChip"
            )
            Text("Coming soon")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - Subagent Status
            GallerySectionHeader(
                title: "Subagent Status",
                description: "SubagentStatusChip, SubagentThreadView"
            )
            Text("Coming soon")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - Tool Chips
            GallerySectionHeader(
                title: "Tool Chips",
                description: "ToolCallChip"
            )
            Text("Coming soon")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - Step Indicators
            GallerySectionHeader(
                title: "Step Indicators",
                description: "CurrentStepIndicator, ToolCallProgressBar"
            )
            Text("Coming soon")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - Completion Lists
            GallerySectionHeader(
                title: "Completion Lists",
                description: "UsedToolsListCompact"
            )
            Text("Coming soon")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - Progress Indicators
            GallerySectionHeader(
                title: "Progress Indicators",
                description: "LiveToolProgressView, TypingIndicatorView"
            )
            Text("Coming soon")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - Tool Confirmations
            GallerySectionHeader(
                title: "Tool Confirmations",
                description: "ToolConfirmationBubble"
            )
            Text("Coming soon")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
    }
}
#endif

#if DEBUG
import SwiftUI

struct ChatGallerySection: View {
    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            // MARK: - Error Banners
            GallerySectionHeader(
                title: "Error Banners",
                description: "ChatErrorBanner"
            )
            Text("Coming soon")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - Skill Invocation
            GallerySectionHeader(
                title: "Skill Invocation",
                description: "SkillInvocationChip"
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    SkillInvocationChip(
                        data: SkillInvocationData(
                            name: "Summarize",
                            emoji: "\u{1F4DD}",
                            description: "Condense long text into key points and takeaways."
                        )
                    )

                    SkillInvocationChip(
                        data: SkillInvocationData(
                            name: "Web Search",
                            emoji: "\u{1F50D}",
                            description: "Search the web for up-to-date information."
                        )
                    )
                }
            }

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

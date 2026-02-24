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
            Text("Coming soon")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - Subagent Status
            GallerySectionHeader(
                title: "Subagent Status",
                description: "SubagentStatusChip, SubagentThreadView"
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    Text("SubagentStatusChip")
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.textSecondary)

                    SubagentStatusChip(
                        subagent: SubagentInfo(id: "g-1", label: "Research Agent", status: .running)
                    )

                    SubagentStatusChip(
                        subagent: SubagentInfo(id: "g-2", label: "Code Review Agent", status: .completed)
                    )

                    SubagentStatusChip(
                        subagent: {
                            var info = SubagentInfo(id: "g-3", label: "Deploy Agent", status: .failed)
                            info.error = "Connection timed out"
                            return info
                        }()
                    )

                    SubagentStatusChip(
                        subagent: SubagentInfo(id: "g-4", label: "Cleanup Agent", status: .aborted)
                    )
                }
            }

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    Text("SubagentThreadView")
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.textSecondary)

                    SubagentThreadView(
                        subagent: SubagentInfo(id: "t-1", label: "Research Agent", status: .running),
                        events: [
                            SubagentEventItem(timestamp: Date(), kind: .toolUse(name: "web_search"), content: "SwiftUI adaptive colors"),
                            SubagentEventItem(timestamp: Date(), kind: .text, content: "Found several relevant resources on adaptive color tokens.")
                        ]
                    )

                    SubagentThreadView(
                        subagent: SubagentInfo(id: "t-2", label: "Code Review Agent", status: .completed),
                        events: [
                            SubagentEventItem(timestamp: Date(), kind: .text, content: "All checks passed. No issues found."),
                            SubagentEventItem(timestamp: Date(), kind: .text, content: "LGTM — ready to merge.")
                        ]
                    )

                    SubagentThreadView(
                        subagent: SubagentInfo(id: "t-3", label: "Deploy Agent", status: .failed),
                        events: [
                            SubagentEventItem(timestamp: Date(), kind: .error, content: "Connection timed out after 30s")
                        ]
                    )

                    SubagentThreadView(
                        subagent: SubagentInfo(id: "t-4", label: "Cleanup Agent", status: .aborted),
                        events: []
                    )
                }
            }

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

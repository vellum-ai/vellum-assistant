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
                description: "ToolConfirmationBubble — inline permission prompts with risk badges and collapsed decided states."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    Text("Collapsed — approved")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    ToolConfirmationBubble(
                        confirmation: ToolConfirmationData(
                            requestId: "gallery-approved",
                            toolName: "host_bash",
                            input: ["command": AnyCodable("npm install")],
                            riskLevel: "medium",
                            state: .approved
                        ),
                        isKeyboardActive: false,
                        onAllow: {},
                        onDeny: {},
                        onAlwaysAllow: { _, _, _, _ in }
                    )

                    Divider().background(VColor.surfaceBorder)

                    Text("Collapsed — denied")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    ToolConfirmationBubble(
                        confirmation: ToolConfirmationData(
                            requestId: "gallery-denied",
                            toolName: "host_file_write",
                            input: ["path": AnyCodable("/etc/hosts")],
                            riskLevel: "high",
                            state: .denied
                        ),
                        isKeyboardActive: false,
                        onAllow: {},
                        onDeny: {},
                        onAlwaysAllow: { _, _, _, _ in }
                    )

                    Divider().background(VColor.surfaceBorder)

                    Text("Collapsed — timed out")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    ToolConfirmationBubble(
                        confirmation: ToolConfirmationData(
                            requestId: "gallery-timeout",
                            toolName: "host_bash",
                            input: ["command": AnyCodable("rm -rf /tmp/cache")],
                            riskLevel: "medium",
                            state: .timedOut
                        ),
                        isKeyboardActive: false,
                        onAllow: {},
                        onDeny: {},
                        onAlwaysAllow: { _, _, _, _ in }
                    )
                }
            }

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    Text("Pending — low risk")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    ToolConfirmationBubble(
                        confirmation: ToolConfirmationData(
                            requestId: "gallery-low",
                            toolName: "host_bash",
                            input: ["command": AnyCodable("ls -la ~/Documents")],
                            riskLevel: "low",
                            executionTarget: "host"
                        ),
                        isKeyboardActive: false,
                        onAllow: {},
                        onDeny: {},
                        onAlwaysAllow: { _, _, _, _ in }
                    )

                    Divider().background(VColor.surfaceBorder)

                    Text("Pending — medium risk with always-allow")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    ToolConfirmationBubble(
                        confirmation: ToolConfirmationData(
                            requestId: "gallery-medium",
                            toolName: "host_bash",
                            input: ["command": AnyCodable("npm install express")],
                            riskLevel: "medium",
                            allowlistOptions: [
                                ConfirmationRequestMessage.ConfirmationAllowlistOption(
                                    label: "exact", description: "This exact command", pattern: "npm install express"
                                ),
                            ],
                            scopeOptions: [
                                ConfirmationRequestMessage.ConfirmationScopeOption(
                                    label: "This project", scope: "project"
                                ),
                            ],
                            executionTarget: "host"
                        ),
                        isKeyboardActive: false,
                        onAllow: {},
                        onDeny: {},
                        onAlwaysAllow: { _, _, _, _ in }
                    )

                    Divider().background(VColor.surfaceBorder)

                    Text("Pending — high risk")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    ToolConfirmationBubble(
                        confirmation: ToolConfirmationData(
                            requestId: "gallery-high",
                            toolName: "host_file_write",
                            input: ["path": AnyCodable("/Users/me/project/main.swift")],
                            riskLevel: "high",
                            executionTarget: "host"
                        ),
                        isKeyboardActive: false,
                        onAllow: {},
                        onDeny: {},
                        onAlwaysAllow: { _, _, _, _ in }
                    )
                }
            }
        }
    }
}
#endif

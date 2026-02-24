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
                description: "ToolCallChip — collapsed chips showing tool call status with expandable details."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    Text("Completed (success)")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    ToolCallChip(toolCall: ToolCallData(
                        toolName: "bash",
                        inputSummary: "ls -la /Users/test/project",
                        result: "total 42\ndrwxr-xr-x  10 user  staff  320 Jan  1 12:00 .\ndrwxr-xr-x   5 user  staff  160 Jan  1 11:00 ..",
                        isComplete: true
                    ))

                    Divider().background(VColor.surfaceBorder)

                    Text("Completed (error)")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    ToolCallChip(toolCall: ToolCallData(
                        toolName: "bash",
                        inputSummary: "rm -rf /important",
                        result: "Permission denied",
                        isError: true,
                        isComplete: true
                    ))

                    Divider().background(VColor.surfaceBorder)

                    Text("File edit (success)")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    ToolCallChip(toolCall: ToolCallData(
                        toolName: "file_edit",
                        inputSummary: "/src/Config.swift",
                        result: "File updated successfully.",
                        isComplete: true
                    ))

                    Divider().background(VColor.surfaceBorder)

                    Text("In progress")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    ToolCallChip(toolCall: ToolCallData(
                        toolName: "file_read",
                        inputSummary: "/src/main.swift",
                        isComplete: false
                    ))
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - Step Indicators
            GallerySectionHeader(
                title: "Step Indicators",
                description: "CurrentStepIndicator — shows current step with progress count. ToolCallProgressBar — horizontal progress bar with clickable steps."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    Text("CurrentStepIndicator — in progress with multiple steps")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    CurrentStepIndicator(
                        toolCalls: [
                            ToolCallData(
                                toolName: "Web Search",
                                inputSummary: "flights from New York to London",
                                isComplete: true
                            ),
                            ToolCallData(
                                toolName: "Browser Navigate",
                                inputSummary: "https://google.com/flights",
                                isComplete: false
                            ),
                            ToolCallData(
                                toolName: "Browser Click",
                                inputSummary: "Departure field",
                                isComplete: false
                            )
                        ],
                        isStreaming: true,
                        onTap: {}
                    )

                    Divider().background(VColor.surfaceBorder)

                    Text("CurrentStepIndicator — completed")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    CurrentStepIndicator(
                        toolCalls: [
                            ToolCallData(
                                toolName: "Web Search",
                                inputSummary: "flights",
                                isComplete: true
                            ),
                            ToolCallData(
                                toolName: "Browser Navigate",
                                inputSummary: "url",
                                isComplete: true
                            )
                        ],
                        isStreaming: false,
                        onTap: {}
                    )
                }
            }

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    Text("ToolCallProgressBar — multi-step with one in progress")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    ToolCallProgressBar(toolCalls: [
                        ToolCallData(
                            toolName: "Web Search",
                            inputSummary: "flights from New York to London",
                            isComplete: true
                        ),
                        ToolCallData(
                            toolName: "Browser Navigate",
                            inputSummary: "https://www.google.com/travel/flights",
                            result: "Navigated to Google Flights",
                            isComplete: true
                        ),
                        ToolCallData(
                            toolName: "Browser Screenshot",
                            inputSummary: "",
                            isComplete: true
                        ),
                        ToolCallData(
                            toolName: "Browser Click",
                            inputSummary: "[aria-label=\"Departure\"]",
                            isComplete: false
                        )
                    ])

                    Divider().background(VColor.surfaceBorder)

                    Text("ToolCallProgressBar — completed with error")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    ToolCallProgressBar(toolCalls: [
                        ToolCallData(
                            toolName: "Web Search",
                            inputSummary: "flights NYC to London",
                            isComplete: true
                        ),
                        ToolCallData(
                            toolName: "Browser Navigate",
                            inputSummary: "https://www.google.com/travel/flights",
                            isComplete: true
                        ),
                        ToolCallData(
                            toolName: "Browser Click",
                            inputSummary: "invalid selector",
                            result: "Element not found",
                            isError: true,
                            isComplete: true
                        )
                    ])
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - Completion Lists
            GallerySectionHeader(
                title: "Completion Lists",
                description: "UsedToolsListCompact — collapsible pill summarising completed tool steps."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    Text("Completed 3 steps (mix of success and error)")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)

                    UsedToolsListCompact(toolCalls: [
                        ToolCallData(
                            toolName: "file_read",
                            inputSummary: "Sources/App/main.swift",
                            isError: false,
                            isComplete: true,
                            startedAt: Date().addingTimeInterval(-3.2),
                            completedAt: Date()
                        ),
                        ToolCallData(
                            toolName: "bash",
                            inputSummary: "swift build",
                            isError: true,
                            isComplete: true,
                            startedAt: Date().addingTimeInterval(-12.5),
                            completedAt: Date()
                        ),
                        ToolCallData(
                            toolName: "file_edit",
                            inputSummary: "Package.swift",
                            isError: false,
                            isComplete: true,
                            startedAt: Date().addingTimeInterval(-1.8),
                            completedAt: Date()
                        ),
                    ])

                    Divider().background(VColor.surfaceBorder)

                    Text("Single step (shows action description instead of count)")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)

                    UsedToolsListCompact(toolCalls: [
                        ToolCallData(
                            toolName: "web_search",
                            inputSummary: "SwiftUI adaptive layout",
                            isError: false,
                            isComplete: true,
                            startedAt: Date().addingTimeInterval(-2.0),
                            completedAt: Date()
                        ),
                    ])
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - Progress Indicators
            GallerySectionHeader(
                title: "Progress Indicators",
                description: "TypingIndicatorView, LiveToolProgressView, RunningIndicator"
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    Text("TypingIndicatorView — animated dots while assistant is thinking")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)

                    HStack {
                        TypingIndicatorView()
                        Spacer()
                    }

                    Divider().background(VColor.surfaceBorder)

                    Text("LiveToolProgressView — macOS only (clients/macos/)")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    Text("Shows live progress for running tool calls with a spinning indicator and step list. Not available in the shared gallery because it depends on macOS-only imports.")
                        .font(VFont.small)
                        .foregroundColor(VColor.textMuted)

                    Divider().background(VColor.surfaceBorder)

                    Text("RunningIndicator — macOS only (clients/macos/)")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    Text("Spinning arc indicator used alongside tool progress views. Not available in the shared gallery because it depends on macOS-only imports.")
                        .font(VFont.small)
                        .foregroundColor(VColor.textMuted)
                }
            }

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

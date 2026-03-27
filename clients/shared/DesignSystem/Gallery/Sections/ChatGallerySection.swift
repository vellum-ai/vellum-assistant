#if DEBUG
import SwiftUI

struct ChatGallerySection: View {
    var filter: String?

    @State private var voiceComposerAmplitude: Float = 0.5

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            if filter == nil || filter == "voiceComposer" {
                // MARK: - VStreamingWaveform
                GallerySectionHeader(
                    title: "VStreamingWaveform",
                    description: "Streaming waveform in composer context. The composer has three modes: textEntry, dictationInline (with dictation-style waveform), and voiceConversation (with conversation-style waveform)."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        HStack {
                            Text("Amplitude: \(String(format: "%.2f", voiceComposerAmplitude))")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentSecondary)
                            Slider(value: $voiceComposerAmplitude, in: 0...1, step: 0.05)
                                .frame(maxWidth: 200)
                        }

                        Divider().background(VColor.borderBase)

                        Text("Conversation style (voice mode)")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentSecondary)
                        VStreamingWaveform(
                            amplitude: voiceComposerAmplitude,
                            isActive: true,
                            style: .conversation,
                            foregroundColor: VColor.primaryBase
                        )
                        .frame(width: 120, height: 60)

                        Divider().background(VColor.borderBase)

                        Text("Dictation style (inline dictation)")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentSecondary)
                        VStreamingWaveform(
                            amplitude: voiceComposerAmplitude,
                            isActive: true,
                            style: .dictation,
                            foregroundColor: VColor.primaryBase
                        )
                        .frame(height: 24)
                        .frame(maxWidth: .infinity)
                    }
                }
            }

            if filter == nil || filter == "subagentStatus" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - SubagentStatusChip
                GallerySectionHeader(
                    title: "SubagentStatusChip",
                    description: "Status chip and conversation view for subagent progress. Includes SubagentConversationView."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("SubagentStatusChip")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentSecondary)

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
                        Text("SubagentConversationView")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentSecondary)

                        SubagentConversationView(
                            subagent: SubagentInfo(id: "t-1", label: "Research Agent", status: .running),
                            events: [
                                SubagentEventItem(timestamp: Date(), kind: .toolUse(name: "web_search"), content: "SwiftUI adaptive colors"),
                                SubagentEventItem(timestamp: Date(), kind: .text, content: "Found several relevant resources on adaptive color tokens.")
                            ]
                        )

                        SubagentConversationView(
                            subagent: SubagentInfo(id: "t-2", label: "Code Review Agent", status: .completed),
                            events: [
                                SubagentEventItem(timestamp: Date(), kind: .text, content: "All checks passed. No issues found."),
                                SubagentEventItem(timestamp: Date(), kind: .text, content: "LGTM — ready to merge.")
                            ]
                        )

                        SubagentConversationView(
                            subagent: SubagentInfo(id: "t-3", label: "Deploy Agent", status: .failed),
                            events: [
                                SubagentEventItem(timestamp: Date(), kind: .error, content: "Connection timed out after 30s")
                            ]
                        )

                        SubagentConversationView(
                            subagent: SubagentInfo(id: "t-4", label: "Cleanup Agent", status: .aborted),
                            events: []
                        )
                    }
                }
            }

            if filter == nil || filter == "toolChips" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - ToolCallChip
                GallerySectionHeader(
                    title: "ToolCallChip",
                    description: "Collapsed chips showing tool call status with expandable details."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Completed (success)")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        ToolCallChip(toolCall: ToolCallData(
                            toolName: "bash",
                            inputSummary: "ls -la /Users/test/project",
                            result: "total 42\ndrwxr-xr-x  10 user  staff  320 Jan  1 12:00 .\ndrwxr-xr-x   5 user  staff  160 Jan  1 11:00 ..",
                            isComplete: true
                        ))

                        Divider().background(VColor.borderBase)

                        Text("Completed (error)")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        ToolCallChip(toolCall: ToolCallData(
                            toolName: "bash",
                            inputSummary: "rm -rf /important",
                            result: "Permission denied",
                            isError: true,
                            isComplete: true
                        ))

                        Divider().background(VColor.borderBase)

                        Text("File edit (success)")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        ToolCallChip(toolCall: ToolCallData(
                            toolName: "file_edit",
                            inputSummary: "/src/Config.swift",
                            result: "File updated successfully.",
                            isComplete: true
                        ))

                        Divider().background(VColor.borderBase)

                        Text("In progress")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        ToolCallChip(toolCall: ToolCallData(
                            toolName: "file_read",
                            inputSummary: "/src/main.swift",
                            isComplete: false
                        ))
                    }
                }
            }

            if filter == nil || filter == "stepIndicators" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - CurrentStepIndicator
                GallerySectionHeader(
                    title: "CurrentStepIndicator",
                    description: "Shows current step with progress count. Also includes ToolCallProgressBar — horizontal progress bar with clickable steps."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("CurrentStepIndicator — in progress with multiple steps")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
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

                        Divider().background(VColor.borderBase)

                        Text("CurrentStepIndicator — completed")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
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
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
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

                        Divider().background(VColor.borderBase)

                        Text("ToolCallProgressBar — completed with error")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
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
            }

            if filter == nil || filter == "progressIndicators" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - TypingIndicatorView
                GallerySectionHeader(
                    title: "TypingIndicatorView",
                    description: "Animated typing dots, assistant progress, and running indicators. Includes AssistantProgressView and RunningIndicator (macOS only)."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("TypingIndicatorView — animated dots while assistant is thinking")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)

                        HStack {
                            TypingIndicatorView()
                            Spacer()
                        }

                        Divider().background(VColor.borderBase)

                        Text("AssistantProgressView — macOS only (clients/macos/)")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        Text("Unified container for all tool progress states. Smoothly morphs between thinking, running, streaming code, and completed phases. Not available in the shared gallery because it depends on macOS-only imports.")
                            .font(VFont.labelSmall)
                            .foregroundStyle(VColor.contentTertiary)

                        Divider().background(VColor.borderBase)

                        Text("RunningIndicator — macOS only (clients/macos/)")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        Text("Spinning arc indicator used alongside tool progress views. Not available in the shared gallery because it depends on macOS-only imports.")
                            .font(VFont.labelSmall)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                }
            }

            if filter == nil || filter == "toolConfirmations" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - ToolConfirmationBubble
                GallerySectionHeader(
                    title: "ToolConfirmationBubble",
                    description: "Inline permission prompts with risk badges and collapsed decided states."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Collapsed — approved")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
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

                        Divider().background(VColor.borderBase)

                        Text("Collapsed — denied")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
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

                        Divider().background(VColor.borderBase)

                        Text("Collapsed — timed out")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
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
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
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

                        Divider().background(VColor.borderBase)

                        Text("Pending — medium risk with always-allow")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        ToolConfirmationBubble(
                            confirmation: ToolConfirmationData(
                                requestId: "gallery-medium",
                                toolName: "host_bash",
                                input: ["command": AnyCodable("npm install express")],
                                riskLevel: "medium",
                                allowlistOptions: [
                                    ConfirmationRequestAllowlistOption(
                                        label: "exact", description: "This exact command", pattern: "npm install express"
                                    ),
                                ],
                                scopeOptions: [
                                    ConfirmationRequestScopeOption(
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

                        Divider().background(VColor.borderBase)

                        Text("Pending — high risk")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
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

            if filter == nil || filter == "surfaceActions" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - Surface Action Buttons
                GallerySectionHeader(
                    title: "Surface Action Buttons",
                    description: "Inline action pills rendered inside assistant chat bubbles. Used by InlineSurfaceRouter to let the user pick from options the assistant presents."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Styles").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)

                        VStack(alignment: .leading, spacing: VSpacing.sm) {
                            surfaceActionPill(label: "Summarize a file on my machine", style: .secondary)
                            surfaceActionPill(label: "Research a topic and make me a deck", style: .secondary)
                            surfaceActionPill(label: "Vibe code an app", style: .secondary)
                        }

                        Divider().background(VColor.borderBase)

                        Text("Primary").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)
                        surfaceActionPill(label: "Confirm and proceed", style: .primary)

                        Text("Destructive").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)
                        surfaceActionPill(label: "Delete all files", style: .destructive)
                    }
                }
            }

        }
    }

    private func surfaceActionPill(label: String, style: SurfaceActionStyle) -> some View {
        Text(label)
            .font(VFont.bodyMediumDefault)
            .foregroundStyle(surfaceActionForeground(style))
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(surfaceActionBackground(style))
            )
    }

    private func surfaceActionForeground(_ style: SurfaceActionStyle) -> Color {
        switch style {
        case .primary: return VColor.auxWhite
        case .destructive: return VColor.auxWhite
        case .secondary: return VColor.contentDefault
        }
    }

    private func surfaceActionBackground(_ style: SurfaceActionStyle) -> Color {
        switch style {
        case .primary: return VColor.primaryBase
        case .destructive: return VColor.systemNegativeStrong
        case .secondary: return VColor.borderBase.opacity(0.5)
        }
    }
}

// MARK: - Component Page Router

extension ChatGallerySection {
    @ViewBuilder
    static func componentPage(_ id: String) -> some View {
        switch id {
        case "voiceComposer": ChatGallerySection(filter: "voiceComposer")

        case "subagentStatus": ChatGallerySection(filter: "subagentStatus")
        case "toolChips": ChatGallerySection(filter: "toolChips")
        case "stepIndicators": ChatGallerySection(filter: "stepIndicators")
        case "progressIndicators": ChatGallerySection(filter: "progressIndicators")
        case "toolConfirmations": ChatGallerySection(filter: "toolConfirmations")
        case "surfaceActions": ChatGallerySection(filter: "surfaceActions")
        default: EmptyView()
        }
    }
}
#endif

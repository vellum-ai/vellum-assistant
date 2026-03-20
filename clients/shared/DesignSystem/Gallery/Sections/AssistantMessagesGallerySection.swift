#if DEBUG
import SwiftUI

struct AssistantMessagesGallerySection: View {
    var filter: String?

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {

            // MARK: - ConfirmationSurfaceView
            if filter == nil || filter == "confirmationSurface" {
                GallerySectionHeader(
                    title: "ConfirmationSurfaceView",
                    description: "Inline confirmation card with pending and dismissed states. Uses surfaceOverlay at 0.5 opacity for the dismissed pill."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Pending — standard")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        ConfirmationSurfaceView(
                            data: ConfirmationSurfaceData(
                                message: "Send this email to 12 recipients?",
                                detail: "This action cannot be undone.",
                                destructive: false
                            ),
                            actions: [
                                SurfaceActionButton(id: "cancel", label: "Cancel", style: .secondary, index: 0),
                                SurfaceActionButton(id: "confirm", label: "Send", style: .primary, index: 1),
                            ],
                            onAction: { _ in }
                        )

                        Divider().background(VColor.borderBase)

                        Text("Pending — destructive")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        ConfirmationSurfaceView(
                            data: ConfirmationSurfaceData(
                                message: "Delete all project files?",
                                detail: "This will permanently remove 42 files from the workspace.",
                                confirmLabel: "Delete",
                                cancelLabel: "Keep",
                                destructive: true
                            ),
                            actions: [
                                SurfaceActionButton(id: "cancel", label: "Keep", style: .secondary, index: 0),
                                SurfaceActionButton(id: "confirm", label: "Delete", style: .primary, index: 1),
                            ],
                            onAction: { _ in }
                        )
                    }
                }
            }

            // MARK: - CompletedSurfaceChip
            if filter == nil || filter == "completedSurfaceChip" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                GallerySectionHeader(
                    title: "CompletedSurfaceChip",
                    description: "Compact chip replacing an interactive surface after the user completes it. Uses surfaceBase at 0.5 opacity."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("With title")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        CompletedSurfaceChip(title: "Feedback Form", summary: "Submitted successfully")

                        Divider().background(VColor.borderBase)

                        Text("Without title")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        CompletedSurfaceChip(title: nil, summary: "File uploaded (3 items)")

                        Divider().background(VColor.borderBase)

                        Text("Long summary")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        CompletedSurfaceChip(title: "Configuration", summary: "API key saved, provider set to Anthropic, model updated to Claude Sonnet")
                    }
                }
            }

            // MARK: - InlineFallbackChip
            if filter == nil || filter == "inlineFallbackChip" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                GallerySectionHeader(
                    title: "InlineFallbackChip",
                    description: "Placeholder shown when an inline surface type is unsupported. Uses surfaceBase at 0.5 opacity."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        InlineFallbackChip(surfaceType: .card)
                        InlineFallbackChip(surfaceType: .table)
                        InlineFallbackChip(surfaceType: .documentPreview)
                    }
                }
            }

            // MARK: - CommandListBubble
            if filter == nil || filter == "commandListBubble" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                GallerySectionHeader(
                    title: "CommandListBubble",
                    description: "Rendered when the assistant outputs a parseable command list. Uses surfaceBase as a solid background."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        CommandListBubble(commands: [
                            .init(id: "/help", description: "Show available commands"),
                            .init(id: "/model", description: "Switch the active model"),
                            .init(id: "/clear", description: "Clear conversation history"),
                            .init(id: "/export", description: "Export conversation as markdown"),
                        ])
                    }
                }
            }

            // MARK: - ModelListBubble
            if filter == nil || filter == "modelListBubble" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                GallerySectionHeader(
                    title: "ModelListBubble",
                    description: "Rendered when the assistant lists available models. Uses surfaceBase as a solid background."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        ModelListBubble(
                            currentModel: "claude-sonnet-4-5-20250514",
                            configuredProviders: Set(["anthropic"]),
                            providerCatalog: [
                                ProviderCatalogEntry(
                                    id: "anthropic",
                                    displayName: "Anthropic",
                                    models: [
                                        CatalogModel(id: "claude-sonnet-4-5-20250514", displayName: "Claude 4.5 Sonnet"),
                                        CatalogModel(id: "claude-haiku-3-5-20241022", displayName: "Claude 3.5 Haiku"),
                                    ],
                                    defaultModel: "claude-sonnet-4-5-20250514"
                                ),
                                ProviderCatalogEntry(
                                    id: "openai",
                                    displayName: "OpenAI",
                                    models: [
                                        CatalogModel(id: "gpt-4o", displayName: "GPT-4o"),
                                        CatalogModel(id: "gpt-4o-mini", displayName: "GPT-4o Mini"),
                                    ],
                                    defaultModel: "gpt-4o"
                                ),
                            ]
                        )
                    }
                }
            }

            // MARK: - ToolCallProgressBar
            if filter == nil || filter == "toolCallProgressBar" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                GallerySectionHeader(
                    title: "ToolCallProgressBar",
                    description: "Horizontal progress bar with clickable steps. Uses surfaceBase as a solid background."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Multi-step — in progress")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        ToolCallProgressBar(toolCalls: [
                            ToolCallData(toolName: "Web Search", inputSummary: "best coffee shops", isComplete: true),
                            ToolCallData(toolName: "Browser Navigate", inputSummary: "https://yelp.com", result: "Page loaded", isComplete: true),
                            ToolCallData(toolName: "Browser Screenshot", inputSummary: "", isComplete: false),
                        ])

                        Divider().background(VColor.borderBase)

                        Text("All completed")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        ToolCallProgressBar(toolCalls: [
                            ToolCallData(toolName: "file_read", inputSummary: "Config.swift", isComplete: true),
                            ToolCallData(toolName: "file_edit", inputSummary: "Config.swift", result: "Updated", isComplete: true),
                        ])
                    }
                }
            }

            // MARK: - CurrentStepIndicator
            if filter == nil || filter == "currentStepIndicator" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                GallerySectionHeader(
                    title: "CurrentStepIndicator",
                    description: "Shows current step name with a spinner or checkmark. Uses surfaceBase as a solid background."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("In progress")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        CurrentStepIndicator(
                            toolCalls: [
                                ToolCallData(toolName: "Searching", inputSummary: "documentation", isComplete: true),
                                ToolCallData(toolName: "Reading file", inputSummary: "main.swift", isComplete: false),
                            ],
                            isStreaming: true,
                            onTap: {}
                        )

                        Divider().background(VColor.borderBase)

                        Text("Completed")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        CurrentStepIndicator(
                            toolCalls: [
                                ToolCallData(toolName: "Done", inputSummary: "", isComplete: true),
                            ],
                            isStreaming: false,
                            onTap: {}
                        )
                    }
                }
            }

            // MARK: - TypingIndicatorView
            if filter == nil || filter == "typingIndicator" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                GallerySectionHeader(
                    title: "TypingIndicatorView",
                    description: "Animated three-dot indicator. Uses surfaceBase as a solid background."
                )

                VCard {
                    HStack {
                        TypingIndicatorView()
                        Spacer()
                    }
                }
            }

            // MARK: - SubagentStatusChip
            if filter == nil || filter == "subagentStatusChip" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                GallerySectionHeader(
                    title: "SubagentStatusChip",
                    description: "Status chip for subagent progress. Uses surfaceBase at 0.3 opacity."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        SubagentStatusChip(subagent: SubagentInfo(id: "g-1", label: "Research Agent", status: .running))
                        SubagentStatusChip(subagent: SubagentInfo(id: "g-2", label: "Code Review", status: .completed))
                        SubagentStatusChip(subagent: {
                            var info = SubagentInfo(id: "g-3", label: "Deploy Agent", status: .failed)
                            info.error = "Timeout after 30s"
                            return info
                        }())
                        SubagentStatusChip(subagent: SubagentInfo(id: "g-4", label: "Cleanup", status: .aborted))
                    }
                }
            }

            // MARK: - SubagentConversationView
            if filter == nil || filter == "subagentConversation" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                GallerySectionHeader(
                    title: "SubagentConversationView",
                    description: "Threaded conversation indicator for subagents. Uses surfaceBase at 0.2/0.5 opacity (hover)."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        SubagentConversationView(
                            subagent: SubagentInfo(id: "t-1", label: "Research Agent", status: .running),
                            events: [
                                SubagentEventItem(timestamp: Date(), kind: .toolUse(name: "web_search"), content: "SwiftUI color tokens"),
                                SubagentEventItem(timestamp: Date(), kind: .text, content: "Found 3 relevant resources."),
                            ]
                        )

                        SubagentConversationView(
                            subagent: SubagentInfo(id: "t-2", label: "Code Review", status: .completed),
                            events: [
                                SubagentEventItem(timestamp: Date(), kind: .text, content: "All checks passed. LGTM."),
                            ]
                        )
                    }
                }
            }

            // MARK: - FormSurfaceView
            if filter == nil || filter == "formSurface" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                GallerySectionHeader(
                    title: "FormSurfaceView",
                    description: "Interactive form with fields. The security info pill uses surfaceBase at 0.5 opacity when password fields are present."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("With password field (shows security pill)")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        FormSurfaceView(
                            data: FormSurfaceData(
                                description: "Enter your API credentials",
                                fields: [
                                    FormField(id: "username", type: .text, label: "Username", placeholder: "your-username", required: true),
                                    FormField(id: "api_key", type: .password, label: "API Key", placeholder: "sk-...", required: true),
                                ],
                                submitLabel: "Save"
                            ),
                            onSubmit: { _ in }
                        )

                        Divider().background(VColor.borderBase)

                        Text("Standard form (no password)")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        FormSurfaceView(
                            data: FormSurfaceData(
                                description: "Configure your project settings",
                                fields: [
                                    FormField(id: "name", type: .text, label: "Project Name", placeholder: "My Project", required: true),
                                    FormField(
                                        id: "env", type: .select, label: "Environment", required: true,
                                        defaultValue: .string("dev"),
                                        options: [
                                            FormFieldOption(label: "Development", value: "dev"),
                                            FormFieldOption(label: "Staging", value: "staging"),
                                            FormFieldOption(label: "Production", value: "prod"),
                                        ]
                                    ),
                                    FormField(id: "verbose", type: .toggle, label: "Verbose logging", required: false, defaultValue: .boolean(false)),
                                ],
                                submitLabel: "Create"
                            ),
                            onSubmit: { _ in }
                        )
                    }
                }
            }

            // MARK: - FileUploadSurfaceView
            #if os(macOS)
            if filter == nil || filter == "fileUploadSurface" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                GallerySectionHeader(
                    title: "FileUploadSurfaceView",
                    description: "File upload drop zone with file list. File chips use surfaceBase as a solid background. macOS only."
                )

                VCard {
                    FileUploadSurfaceView(
                        data: FileUploadSurfaceData(
                            prompt: "Upload your documents for analysis",
                            acceptedTypes: [".pdf", ".txt", ".md"],
                            maxFiles: 5,
                            maxSizeBytes: 10_485_760
                        ),
                        onSubmit: { _ in },
                        onCancel: {}
                    )
                }
            }
            #endif

            // MARK: - InlineImageEmbedView (placeholder)
            if filter == nil || filter == "imageEmbedPlaceholder" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                GallerySectionHeader(
                    title: "InlineImageEmbedView — Placeholder",
                    description: "Skeleton placeholder shown while an image is loading. Uses surfaceBase as a solid fill. The actual image loads asynchronously on appear."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Placeholder skeleton (what you see before image loads)")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)

                        RoundedRectangle(cornerRadius: 8)
                            .fill(VColor.surfaceBase)
                            .frame(maxWidth: .infinity)
                            .frame(height: 120)
                    }
                }
            }
        }
    }
}

// MARK: - Component Page Router

extension AssistantMessagesGallerySection {
    @ViewBuilder
    static func componentPage(_ id: String) -> some View {
        switch id {
        case "confirmationSurface": AssistantMessagesGallerySection(filter: "confirmationSurface")
        case "completedSurfaceChip": AssistantMessagesGallerySection(filter: "completedSurfaceChip")
        case "inlineFallbackChip": AssistantMessagesGallerySection(filter: "inlineFallbackChip")
        case "commandListBubble": AssistantMessagesGallerySection(filter: "commandListBubble")
        case "modelListBubble": AssistantMessagesGallerySection(filter: "modelListBubble")
        case "toolCallProgressBar": AssistantMessagesGallerySection(filter: "toolCallProgressBar")
        case "currentStepIndicator": AssistantMessagesGallerySection(filter: "currentStepIndicator")
        case "typingIndicator": AssistantMessagesGallerySection(filter: "typingIndicator")
        case "subagentStatusChip": AssistantMessagesGallerySection(filter: "subagentStatusChip")
        case "subagentConversation": AssistantMessagesGallerySection(filter: "subagentConversation")
        case "formSurface": AssistantMessagesGallerySection(filter: "formSurface")
        case "fileUploadSurface": AssistantMessagesGallerySection(filter: "fileUploadSurface")
        case "imageEmbedPlaceholder": AssistantMessagesGallerySection(filter: "imageEmbedPlaceholder")
        default: EmptyView()
        }
    }
}
#endif

#if DEBUG
import SwiftUI

struct FeedbackGallerySection: View {
    var filter: String?

    @State private var badgeCount: Double = 5

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            if filter == nil || filter == "vBadge" {
                // MARK: - VBadge
                GallerySectionHeader(
                    title: "VBadge",
                    description: "Compact status indicator: count, dot, or label."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        // Count badges with slider
                        HStack {
                            Text("Count: \(Int(badgeCount))")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentSecondary)
                            Slider(value: $badgeCount, in: 1...99, step: 1)
                                .frame(maxWidth: 200)
                        }

                        Divider().background(VColor.borderBase)

                        // Count row
                        HStack(spacing: VSpacing.xl) {
                            VStack(spacing: VSpacing.xs) {
                                Text("Accent").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VBadge(count: Int(badgeCount), tone: .accent)
                            }
                            VStack(spacing: VSpacing.xs) {
                                Text("Success").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VBadge(count: Int(badgeCount), tone: .positive)
                            }
                            VStack(spacing: VSpacing.xs) {
                                Text("Error").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VBadge(count: Int(badgeCount), tone: .danger)
                            }
                            VStack(spacing: VSpacing.xs) {
                                Text("Warning").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VBadge(count: Int(badgeCount), tone: .warning)
                            }
                        }

                        // Dot row
                        HStack(spacing: VSpacing.xl) {
                            VStack(spacing: VSpacing.xs) {
                                Text("Dot").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                HStack(spacing: VSpacing.md) {
                                    VBadge(style: .dot, color: VColor.primaryBase)
                                    VBadge(style: .dot, color: VColor.systemPositiveStrong)
                                    VBadge(style: .dot, color: VColor.systemNegativeStrong)
                                    VBadge(style: .dot, color: VColor.systemNegativeHover)
                                }
                            }
                        }

                        // Label with tone (subtle)
                        VStack(alignment: .leading, spacing: VSpacing.sm) {
                            Text("Subtle labels").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            HStack(spacing: VSpacing.lg) {
                                VBadge(label: "Accent", tone: .accent)
                                VBadge(label: "Neutral", tone: .neutral)
                                VBadge(label: "Positive", tone: .positive)
                                VBadge(label: "Warning", tone: .warning)
                                VBadge(label: "Danger", tone: .danger)
                            }
                        }

                        Divider().background(VColor.borderBase)

                        // Label with tone (solid)
                        VStack(alignment: .leading, spacing: VSpacing.sm) {
                            Text("Solid labels").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            HStack(spacing: VSpacing.lg) {
                                VBadge(label: "Accent", tone: .accent, emphasis: .solid)
                                VBadge(label: "Neutral", tone: .neutral, emphasis: .solid)
                                VBadge(label: "Positive", tone: .positive, emphasis: .solid)
                                VBadge(label: "Warning", tone: .warning, emphasis: .solid)
                                VBadge(label: "Danger", tone: .danger, emphasis: .solid)
                            }
                        }
                    }
                }
            }

            if filter == nil || filter == "vTag" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VTag
                GallerySectionHeader(
                    title: "VTag",
                    description: "Colored tag for categorizing items (e.g. memory kinds)."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        HStack(spacing: VSpacing.lg) {
                            VTag("Identity", color: VColor.funTeal)
                            VTag("Preference", color: VColor.funPurple)
                            VTag("Project", color: VColor.funGreen)
                            VTag("Decision", color: VColor.funYellow)
                            VTag("Constraint", color: VColor.funCoral)
                            VTag("Event", color: VColor.funPink)
                            VTag("Skill", color: VColor.funRed)
                        }

                        Divider().background(VColor.borderBase)

                        // With icon
                        VStack(alignment: .leading, spacing: VSpacing.sm) {
                            Text("With icon").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            HStack(spacing: VSpacing.lg) {
                                VTag("Identity", color: VColor.funTeal, icon: .user)
                                VTag("Event", color: VColor.funPink, icon: .calendar)
                                VTag("Project", color: VColor.funGreen, icon: .folder)
                            }
                        }
                    }
                }
            }

            if filter == nil || filter == "vLoadingIndicator" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VLoadingIndicator
                GallerySectionHeader(
                    title: "VLoadingIndicator",
                    description: "Spinning loading indicator with configurable size and color."
                )

                VCard {
                    HStack(spacing: VSpacing.xxl) {
                        VStack(spacing: VSpacing.md) {
                            Text("Small (14)").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VLoadingIndicator(size: 14, color: VColor.primaryBase)
                        }
                        VStack(spacing: VSpacing.md) {
                            Text("Default (20)").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VLoadingIndicator()
                        }
                        VStack(spacing: VSpacing.md) {
                            Text("Large (32)").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VLoadingIndicator(size: 32, color: VColor.primaryBase)
                        }
                        VStack(spacing: VSpacing.md) {
                            Text("Success").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VLoadingIndicator(color: VColor.systemPositiveStrong)
                        }
                        VStack(spacing: VSpacing.md) {
                            Text("Error").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VLoadingIndicator(color: VColor.systemNegativeStrong)
                        }
                        VStack(spacing: VSpacing.md) {
                            Text("Warning").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VLoadingIndicator(color: VColor.systemMidStrong)
                        }
                    }
                }
            }

            if filter == nil || filter == "vToast" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VToast
                GallerySectionHeader(
                    title: "VToast",
                    description: "Notification toast with info, success, warning, and error styles."
                )

                VStack(spacing: VSpacing.md) {
                    VToast(message: "Here's some useful information.", style: .info)
                    VToast(message: "Operation completed successfully!", style: .success)
                    VToast(message: "Please check your configuration.", style: .warning)
                    VToast(message: "Something went wrong.", style: .error)
                }

                Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

                // MARK: - VToast with Copyable Detail
                GallerySectionHeader(
                    title: "VToast with Copyable Detail",
                    description: "Error toast with a clipboard button that copies debug information."
                )

                VStack(spacing: VSpacing.md) {
                    VToast(
                        message: "Request failed unexpectedly.",
                        style: .error,
                        copyableDetail: "RequestError: timeout after 30s at /v1/chat/completions (req_abc123)"
                    )
                    VToast(
                        message: "Could not connect to provider.",
                        style: .error,
                        copyableDetail: "ConnectionRefused: 127.0.0.1:8080",
                        primaryAction: VToastAction(label: "Retry") {},
                        onDismiss: {}
                    )
                }

                Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

                // MARK: - VToast with Actions
                GallerySectionHeader(
                    title: "VToast with Actions",
                    description: "Error toasts with retry, copy debug, and dismiss actions."
                )

                VStack(spacing: VSpacing.md) {
                    VToast(
                        message: "Network error. Check your connection.",
                        style: .error,
                        primaryAction: VToastAction(label: "Retry") {},
                        onDismiss: {}
                    )
                    VToast(
                        message: "The AI provider returned an error.",
                        style: .error,
                        primaryAction: VToastAction(label: "Retry") {},
                        secondaryAction: VToastAction(label: "Copy Debug Info") {},
                        onDismiss: {}
                    )
                    VToast(
                        message: "Conversation was interrupted.",
                        style: .warning,
                        onDismiss: {}
                    )
                }
            }

            if filter == nil || filter == "vNotification" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VNotification
                GallerySectionHeader(
                    title: "VNotification",
                    description: "Compact single-line feedback bar. Supports 4 tones × 2 styles, with optional leading icon, action label, and dismiss button."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        // 4 tones × 2 styles grid
                        LazyVGrid(
                            columns: [GridItem(.flexible()), GridItem(.flexible())],
                            spacing: VSpacing.md
                        ) {
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Positive · Weak").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VNotification(
                                    "This is a notification component",
                                    tone: .positive,
                                    style: .weak,
                                    actionLabel: "Action",
                                    onAction: {},
                                    onDismiss: {}
                                )
                            }
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Positive · Strong").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VNotification(
                                    "This is a notification component",
                                    tone: .positive,
                                    style: .strong,
                                    actionLabel: "Action",
                                    onAction: {},
                                    onDismiss: {}
                                )
                            }
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Negative · Weak").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VNotification(
                                    "This is a notification component",
                                    tone: .negative,
                                    style: .weak,
                                    actionLabel: "Action",
                                    onAction: {},
                                    onDismiss: {}
                                )
                            }
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Negative · Strong").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VNotification(
                                    "This is a notification component",
                                    tone: .negative,
                                    style: .strong,
                                    actionLabel: "Action",
                                    onAction: {},
                                    onDismiss: {}
                                )
                            }
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Warning · Weak").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VNotification(
                                    "This is a notification component",
                                    tone: .warning,
                                    style: .weak,
                                    actionLabel: "Action",
                                    onAction: {},
                                    onDismiss: {}
                                )
                            }
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Warning · Strong").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VNotification(
                                    "This is a notification component",
                                    tone: .warning,
                                    style: .strong,
                                    actionLabel: "Action",
                                    onAction: {},
                                    onDismiss: {}
                                )
                            }
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Neutral · Weak").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VNotification(
                                    "This is a notification component",
                                    tone: .neutral,
                                    style: .weak,
                                    actionLabel: "Action",
                                    onAction: {},
                                    onDismiss: {}
                                )
                            }
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Neutral · Strong").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VNotification(
                                    "This is a notification component",
                                    tone: .neutral,
                                    style: .strong,
                                    actionLabel: "Action",
                                    onAction: {},
                                    onDismiss: {}
                                )
                            }
                        }

                        Divider().background(VColor.borderBase)

                        // Optional slots
                        Text("Optional slots")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentSecondary)
                        VStack(alignment: .leading, spacing: VSpacing.sm) {
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Message only").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VNotification(
                                    "This is a notification component",
                                    tone: .positive,
                                    style: .weak
                                )
                            }
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Message + dismiss").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VNotification(
                                    "This is a notification component",
                                    tone: .positive,
                                    style: .weak,
                                    onDismiss: {}
                                )
                            }
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Message + action").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VNotification(
                                    "This is a notification component",
                                    tone: .positive,
                                    style: .weak,
                                    actionLabel: "Action",
                                    onAction: {}
                                )
                            }
                        }
                    }
                }
            }

            if filter == nil || filter == "vInlineMessage" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VInlineMessage
                GallerySectionHeader(
                    title: "VInlineMessage",
                    description: "Compact inline banner for form status, warnings, and errors."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        VInlineMessage("This setting will sync the next time the assistant reconnects.", tone: .info)
                        VInlineMessage("Your Twilio configuration is incomplete.", tone: .warning)
                        VInlineMessage("This Telegram token was rejected by the provider.", tone: .error)
                        VInlineMessage("Phone verification is complete.", tone: .success)
                    }
                }
            }

            if filter == nil || filter == "vShortcutTag" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VShortcutTag
                GallerySectionHeader(
                    title: "VShortcutTag",
                    description: "Clickable pill displaying a keyboard shortcut hint, with optional icon."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        // Text only
                        HStack(spacing: VSpacing.lg) {
                            VStack(spacing: VSpacing.xs) {
                                Text("Text only").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VShortcutTag("\u{2318}K")
                            }
                            VStack(spacing: VSpacing.xs) {
                                Text("Text only").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VShortcutTag("\u{2318}G")
                            }
                        }

                        Divider().background(VColor.borderBase)

                        // With icon
                        HStack(spacing: VSpacing.lg) {
                            VStack(spacing: VSpacing.xs) {
                                Text("With icon").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VShortcutTag("fn", icon: "mic.fill")
                            }
                            VStack(spacing: VSpacing.xs) {
                                Text("With icon").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VShortcutTag("Esc", icon: "escape")
                            }
                        }
                    }
                }
            }

            if filter == nil || filter == "vCopyButton" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VCopyButton
                GallerySectionHeader(
                    title: "VCopyButton",
                    description: "Copy-to-clipboard ghost button (wraps VButton) with checkmark feedback. Supports size variants."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        // Size variants
                        HStack(spacing: VSpacing.xl) {
                            VStack(spacing: VSpacing.xs) {
                                Text("Regular (default)").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VCopyButton(text: "Hello, world!")
                            }
                            VStack(spacing: VSpacing.xs) {
                                Text("Compact").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VCopyButton(text: "Compact copy", size: .compact)
                            }
                            VStack(spacing: VSpacing.xs) {
                                Text("Inline (18×18)").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VCopyButton(text: "Inline copy", size: .inline)
                            }
                            VStack(spacing: VSpacing.xs) {
                                Text("Custom frame (20pt)").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VCopyButton(text: "Small frame", iconSize: 20)
                            }
                            VStack(spacing: VSpacing.xs) {
                                Text("Large frame (28pt)").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VCopyButton(text: "Large frame", iconSize: 28)
                            }
                        }

                        Divider().background(VColor.borderBase)

                        // Custom hint
                        HStack(spacing: VSpacing.xl) {
                            VStack(spacing: VSpacing.xs) {
                                Text("Custom tooltip").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VCopyButton(text: "api_key_123", accessibilityHint: "Copy API key")
                            }
                        }
                    }
                }
            }

            if filter == nil || filter == "vBusyIndicator" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VBusyIndicator
                GallerySectionHeader(
                    title: "VBusyIndicator",
                    description: "Pulsing dot indicator for busy/processing state. Respects reduced motion."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        // Size variants
                        HStack(spacing: VSpacing.xxl) {
                            VStack(spacing: VSpacing.md) {
                                Text("Small (6)").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VBusyIndicator(size: 6)
                            }
                            VStack(spacing: VSpacing.md) {
                                Text("Default (10)").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VBusyIndicator()
                            }
                            VStack(spacing: VSpacing.md) {
                                Text("Large (16)").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VBusyIndicator(size: 16)
                            }
                        }

                        Divider().background(VColor.borderBase)

                        // Color variants
                        HStack(spacing: VSpacing.xxl) {
                            VStack(spacing: VSpacing.md) {
                                Text("Accent").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VBusyIndicator(color: VColor.primaryBase)
                            }
                            VStack(spacing: VSpacing.md) {
                                Text("Success").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VBusyIndicator(color: VColor.systemPositiveStrong)
                            }
                            VStack(spacing: VSpacing.md) {
                                Text("Error").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VBusyIndicator(color: VColor.systemNegativeStrong)
                            }
                        }
                    }
                }
            }

            if filter == nil || filter == "vSkeletonBone" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VSkeletonBone
                GallerySectionHeader(
                    title: "VSkeletonBone",
                    description: "Skeleton placeholder for loading states. Pairs with .vShimmer() for animation."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        // Text line
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Text line").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VSkeletonBone(height: 14)
                        }

                        Divider().background(VColor.borderBase)

                        // Title
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Title").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VSkeletonBone(width: 200, height: 20)
                        }

                        Divider().background(VColor.borderBase)

                        // Avatar
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Avatar").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VSkeletonBone(width: 40, height: 40, radius: VRadius.pill)
                        }

                        Divider().background(VColor.borderBase)

                        // Paragraph
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Paragraph").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VStack(alignment: .leading, spacing: VSpacing.sm) {
                                VSkeletonBone(height: 14)
                                VSkeletonBone(width: 280, height: 14)
                                VSkeletonBone(width: 200, height: 14)
                            }
                        }
                    }
                }
            }

            if filter == nil || filter == "vSkillTypePill" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VSkillTypePill
                GallerySectionHeader(
                    title: "VSkillTypePill",
                    description: "Pill badge indicating skill type or source."
                )

                VCard {
                    HStack(spacing: VSpacing.lg) {
                        VSkillTypePill(type: .vellum)
                        VSkillTypePill(type: .clawhub)
                        VSkillTypePill(type: .skillssh)
                        VSkillTypePill(type: .custom)
                    }
                }
            }

            if filter == nil || filter == "vContextWindowIndicator" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VContextWindowIndicator
                GallerySectionHeader(
                    title: "VContextWindowIndicator",
                    description: "Circular ring showing context window fill level with hover popover."
                )

                VCard {
                    HStack(spacing: VSpacing.xxl) {
                        VStack(spacing: VSpacing.md) {
                            Text("nil (hidden)").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VContextWindowIndicator(fillRatio: nil)
                                .frame(width: 16, height: 16)
                        }
                        VStack(spacing: VSpacing.md) {
                            Text("0%").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VContextWindowIndicator(fillRatio: 0)
                        }
                        VStack(spacing: VSpacing.md) {
                            Text("30%").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VContextWindowIndicator(fillRatio: 0.3)
                        }
                        VStack(spacing: VSpacing.md) {
                            Text("65%").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VContextWindowIndicator(fillRatio: 0.65)
                        }
                        VStack(spacing: VSpacing.md) {
                            Text("90%").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VContextWindowIndicator(fillRatio: 0.9)
                        }
                    }
                }
            }

            if filter == nil || filter == "vInfoTooltip" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VInfoTooltip
                GallerySectionHeader(
                    title: "VInfoTooltip",
                    description: "Small info-circle icon with hover tooltip for supplementary information."
                )

                VCard {
                    HStack(spacing: VSpacing.xs) {
                        Text("Some setting")
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentDefault)
                        VInfoTooltip("Explanation of this setting.")
                    }
                }
            }

        }
    }
}

// MARK: - Component Page Router

extension FeedbackGallerySection {
    @ViewBuilder
    static func componentPage(_ id: String) -> some View {
        switch id {
        case "vBadge": FeedbackGallerySection(filter: "vBadge")
        case "vTag": FeedbackGallerySection(filter: "vTag")
        case "vLoadingIndicator": FeedbackGallerySection(filter: "vLoadingIndicator")
        case "vToast": FeedbackGallerySection(filter: "vToast")
        case "vNotification": FeedbackGallerySection(filter: "vNotification")
        case "vInlineMessage": FeedbackGallerySection(filter: "vInlineMessage")
        case "vShortcutTag": FeedbackGallerySection(filter: "vShortcutTag")
        case "vCopyButton": FeedbackGallerySection(filter: "vCopyButton")
        case "vBusyIndicator": FeedbackGallerySection(filter: "vBusyIndicator")
        case "vSkeletonBone": FeedbackGallerySection(filter: "vSkeletonBone")
        case "vSkillTypePill": FeedbackGallerySection(filter: "vSkillTypePill")
        case "vInfoTooltip": FeedbackGallerySection(filter: "vInfoTooltip")
        case "vContextWindowIndicator": FeedbackGallerySection(filter: "vContextWindowIndicator")
        default: EmptyView()
        }
    }
}
#endif

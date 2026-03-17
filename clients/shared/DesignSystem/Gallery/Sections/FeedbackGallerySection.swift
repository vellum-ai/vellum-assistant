#if DEBUG
import SwiftUI

struct FeedbackGallerySection: View {
    @State private var badgeCount: Double = 5

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
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
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                        Slider(value: $badgeCount, in: 1...99, step: 1)
                            .frame(maxWidth: 200)
                    }

                    Divider().background(VColor.borderBase)

                    // Count row
                    HStack(spacing: VSpacing.xl) {
                        VStack(spacing: VSpacing.xs) {
                            Text("Accent").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VBadge(style: .count(Int(badgeCount)), color: VColor.primaryBase)
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("Success").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VBadge(style: .count(Int(badgeCount)), color: VColor.systemPositiveStrong)
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("Error").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VBadge(style: .count(Int(badgeCount)), color: VColor.systemNegativeStrong)
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("Warning").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VBadge(style: .count(Int(badgeCount)), color: VColor.systemNegativeHover)
                        }
                    }

                    // Dot row
                    HStack(spacing: VSpacing.xl) {
                        VStack(spacing: VSpacing.xs) {
                            Text("Dot").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            HStack(spacing: VSpacing.md) {
                                VBadge(style: .dot, color: VColor.primaryBase)
                                VBadge(style: .dot, color: VColor.systemPositiveStrong)
                                VBadge(style: .dot, color: VColor.systemNegativeStrong)
                                VBadge(style: .dot, color: VColor.systemNegativeHover)
                            }
                        }
                    }

                    // Label row
                    HStack(spacing: VSpacing.lg) {
                        VBadge(style: .label("New"), color: VColor.primaryBase)
                        VBadge(style: .label("Beta"), color: VColor.systemPositiveStrong)
                        VBadge(style: .label("Error"), color: VColor.systemNegativeStrong)
                        VBadge(style: .label("Warn"), color: VColor.systemNegativeHover)
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VLoadingIndicator
            GallerySectionHeader(
                title: "VLoadingIndicator",
                description: "Spinning loading indicator with configurable size and color."
            )

            VCard {
                HStack(spacing: VSpacing.xxl) {
                    VStack(spacing: VSpacing.md) {
                        Text("Small (14)").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VLoadingIndicator(size: 14, color: VColor.primaryBase)
                    }
                    VStack(spacing: VSpacing.md) {
                        Text("Default (20)").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VLoadingIndicator()
                    }
                    VStack(spacing: VSpacing.md) {
                        Text("Large (32)").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VLoadingIndicator(size: 32, color: VColor.primaryBase)
                    }
                    VStack(spacing: VSpacing.md) {
                        Text("Success").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VLoadingIndicator(color: VColor.systemPositiveStrong)
                    }
                    VStack(spacing: VSpacing.md) {
                        Text("Error").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VLoadingIndicator(color: VColor.systemNegativeStrong)
                    }
                    VStack(spacing: VSpacing.md) {
                        Text("Warning").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VLoadingIndicator(color: VColor.systemNegativeHover)
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

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

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

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
                            Text("Text only").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VShortcutTag("\u{2318}K")
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("Text only").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VShortcutTag("\u{2318}G")
                        }
                    }

                    Divider().background(VColor.borderBase)

                    // With icon
                    HStack(spacing: VSpacing.lg) {
                        VStack(spacing: VSpacing.xs) {
                            Text("With icon").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VShortcutTag("fn", icon: "mic.fill")
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("With icon").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VShortcutTag("Esc", icon: "escape")
                        }
                    }
                }
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
    }
}
#endif

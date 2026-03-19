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

                    // Icon label row
                    HStack(spacing: VSpacing.lg) {
                        VStack(spacing: VSpacing.xs) {
                            Text("With iconColor").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VBadge(label: "Guardian", icon: .shieldCheck, iconColor: VColor.primaryBase, tone: .neutral)
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("Default iconColor").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VBadge(label: "Status", icon: .sparkles, tone: .accent)
                        }
                    }

                    Divider().background(VColor.borderBase)

                    // Rounded shape
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Rounded shape").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        HStack(spacing: VSpacing.lg) {
                            VBadge(label: "Identity", color: VColor.funTeal, shape: .rounded)
                            VBadge(label: "Preference", color: VColor.funPurple, shape: .rounded)
                            VBadge(label: "Project", color: VColor.funGreen, shape: .rounded)
                            VBadge(label: "Decision", color: VColor.funYellow, shape: .rounded)
                            VBadge(label: "Constraint", color: VColor.funCoral, shape: .rounded)
                            VBadge(label: "Event", color: VColor.funPink, shape: .rounded)
                        }
                    }

                    // Pill shape with custom color
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Pill shape with custom color").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        HStack(spacing: VSpacing.lg) {
                            VBadge(label: "Teal", color: VColor.funTeal)
                            VBadge(label: "Purple", color: VColor.funPurple)
                            VBadge(label: "Coral", color: VColor.funCoral)
                        }
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
                            Text("Regular (default)").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VCopyButton(text: "Hello, world!")
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("Compact").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VCopyButton(text: "Compact copy", size: .compact)
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("Custom frame (20pt)").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VCopyButton(text: "Small frame", iconSize: 20)
                        }
                        VStack(spacing: VSpacing.xs) {
                            Text("Large frame (28pt)").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VCopyButton(text: "Large frame", iconSize: 28)
                        }
                    }

                    Divider().background(VColor.borderBase)

                    // Custom hint
                    HStack(spacing: VSpacing.xl) {
                        VStack(spacing: VSpacing.xs) {
                            Text("Custom tooltip").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VCopyButton(text: "api_key_123", accessibilityHint: "Copy API key")
                        }
                    }
                }
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
    }
}
#endif
